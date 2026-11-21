"""The ADT_STR network (upstream model.py, inference only) and greedy decoding.

Same layer names as upstream (`compute_spectrogram`, `project_to_mel`, `encoder`, `decoder`), so the
published `model.safetensors` loads with strict=True. Dropout layers are kept as identity: the
model only ever runs in eval mode here.
"""
import math

import torch
import torch.nn as nn
import torchaudio.transforms as T

from adt_str import MAX_TOKENS, SR
from adt_str.tokens import BOS, CLASS, EOS, TIME, VELOCITY

D_QUERY, NHEAD, LAYERS, VOCAB, N_MELS, WIN, TIME_RES = 128, 6, 4, 1400, 128, 2048, 0.01
D_MODEL = D_QUERY * NHEAD  # 768
FFN = D_MODEL * 4
STUCK = 8  # the same hit this many times in a row ends a window (see ADTModel.sample)


class PositionalEncoding(nn.Module):
    def __init__(self, emb_size: int, maxlen: int = 2048):
        super().__init__()
        den = torch.exp(-torch.arange(0, emb_size, 2) * math.log(10000) / emb_size)
        pos = torch.arange(0, maxlen).reshape(maxlen, 1)
        pe = torch.zeros((maxlen, emb_size))
        pe[:, 0::2] = torch.sin(pos * den)
        pe[:, 1::2] = torch.cos(pos * den)
        self.register_buffer("pos_embedding", pe.unsqueeze(0))

    def forward(self, x):
        return x + self.pos_embedding[:, : x.size(1), :]


class TokenEmbedding(nn.Module):
    def __init__(self, vocab: int, emb: int):
        super().__init__()
        self.embedding = nn.Embedding(vocab, emb)
        self.emb_size = emb

    def forward(self, tokens):
        return self.embedding(tokens.long()) * math.sqrt(self.emb_size)


class MelSpectrogram(nn.Module):
    """Log-mel in [0, 1], 10 ms frames, with the STFT's centre-padding frames cropped off."""

    def __init__(self):
        super().__init__()
        hop = int(TIME_RES * SR)
        self.compute_spec = T.MelSpectrogram(sample_rate=SR, n_fft=WIN, hop_length=hop, n_mels=N_MELS, f_min=20.0, power=2)
        self.pad = int((WIN / 2) // hop + 1)

    def forward(self, wave):
        mel = self.compute_spec(wave.float())
        mel = (torch.clamp(torch.log(mel + 1e-10), -23, 12) + 23) / 35
        return mel.permute(0, 2, 1)[:, self.pad : -(self.pad + 1), :]


def _layer(cls):
    return cls(d_model=D_MODEL, nhead=NHEAD, dim_feedforward=FFN, dropout=0.0, activation="gelu", batch_first=True, norm_first=False)


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.dense_layer = nn.Linear(D_MODEL, D_MODEL, bias=False)
        self.positional_encoding = PositionalEncoding(D_MODEL)
        self.layer_norm = nn.LayerNorm(D_MODEL)
        self.encoder = nn.TransformerEncoder(_layer(nn.TransformerEncoderLayer), num_layers=LAYERS, enable_nested_tensor=False)

    def forward(self, x):
        return self.layer_norm(self.encoder(self.positional_encoding(self.dense_layer(x))))


class Decoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.tgt_tok_emb = TokenEmbedding(VOCAB, D_MODEL)
        self.positional_encoding = PositionalEncoding(D_MODEL)
        self.generator = nn.Linear(D_MODEL, VOCAB)
        self.decoder = nn.TransformerDecoder(_layer(nn.TransformerDecoderLayer), num_layers=LAYERS)

    def forward(self, tgt, memory):
        n = tgt.size(1)
        # Additive causal mask with -1e4 (not -inf), as upstream trained it.
        mask = torch.zeros((n, n), device=tgt.device).masked_fill_(torch.ones((n, n), dtype=torch.bool, device=tgt.device).triu(1), -1e4)
        return self.generator(self.decoder(self.positional_encoding(self.tgt_tok_emb(tgt)), memory, tgt_mask=mask))


class ADTModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = Encoder()
        self.decoder = Decoder()
        self.compute_spectrogram = MelSpectrogram()
        self.project_to_mel = nn.Linear(N_MELS, D_MODEL)

    @torch.no_grad()
    def sample(self, wave: torch.Tensor, max_tokens: int = MAX_TOKENS) -> torch.Tensor:
        """Greedy decoding of a batch of 2.56 s windows [B, samples] -> tokens [B, <= max_tokens], as upstream's
        `sample`: the decoder re-runs over the whole prefix each step. That cannot be cached: upstream's -1e4 causal
        mask is weaker than this model's attention scores (up to ~1e5), so earlier positions do see later tokens, and
        the model was trained and evaluated that way. Rows that reached EOS keep emitting EOS until every row is done.

        One addition: greedy decoding can get stuck emitting the same hit (time and class) over and over until the
        length cap (seen on a window that starts on a kick). A row that repeats one hit STUCK times in a row is ended
        there; the repeats would be merged anyway. Upstream output repeats a hit 2-3 times and then goes on, so that
        is left alone. This keeps one stuck window from costing its whole batch 511 steps; rows are independent, so
        the others do not change."""
        memory = self.encoder(self.project_to_mel(self.compute_spectrogram(wave)))
        b = wave.shape[0]
        out = torch.full((b, 1), BOS, dtype=torch.long, device=wave.device)
        done = torch.zeros(b, dtype=torch.bool, device=wave.device)
        last: list[tuple[tuple[int, int], int]] = [((-1, -1), 0)] * b  # per row: last hit, times in a row
        for _ in range(max_tokens - 1):
            nxt = self.decoder(out, memory)[:, -1, :].argmax(-1)
            nxt = torch.where(done, torch.full_like(nxt, EOS), nxt)
            out = torch.cat([out, nxt[:, None]], dim=1)
            done |= nxt == EOS
            if VELOCITY <= int(nxt.max()):  # some row may have just closed a (time, class, velocity) triple
                for r in (~done).nonzero().flatten().tolist():
                    t, c, v = out[r, -3:].tolist()
                    if TIME <= t < CLASS <= c < VELOCITY <= v:
                        n = last[r][1] + 1 if last[r][0] == (t, c) else 1
                        last[r] = ((t, c), n)
                        done[r] = n >= STUCK
            if bool(done.all()):
                break
        return out


def load(path: str, device: str = "cpu") -> ADTModel:
    """The model with the published weights; raises on any missing or unexpected tensor."""
    from safetensors.torch import load_file

    model = ADTModel()
    model.load_state_dict(load_file(path), strict=True)
    return model.to(device).eval()
