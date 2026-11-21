"""SongFormer network, inference only.

Adapted from ASLP-lab/SongFormer `src/SongFormer/models/SongFormer.py` (CC-BY-4.0, see LICENSE):
training losses, metrics and the msaf dependency are removed; module and parameter names are
unchanged so the released checkpoint loads with strict=True.
"""
import torch
import torch.nn as nn
from x_transformers import Encoder

# configs/SongFormer.yaml (model part only)
CONFIG = dict(
    input_dim_raw=4096, input_dim=2048,
    down_sample_conv_kernel_size=3, down_sample_conv_stride=3, down_sample_conv_dropout=0.1, down_sample_conv_padding=0,
    transformer_encoder_input_dim=1024, transformer_input_dim=512, num_transformer_layers=4, transformer_nhead=8,
    transformer_dropout=0.1, num_classes=128, num_dataset_classes=64,
)


class Head(nn.Module):
    def __init__(self, input_dim, output_dim, hidden_dims=None):
        super().__init__()
        dims = [input_dim] + (hidden_dims or []) + [output_dim]
        layers = []
        for i in range(len(dims) - 1):
            layers.append(nn.Linear(dims[i], dims[i + 1]))
            if i < len(dims) - 2:
                layers.append(nn.SiLU())
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        b, t, c = x.shape
        return self.net(x.reshape(-1, c)).reshape(b, t, -1)


class WrapedTransformerEncoder(nn.Module):
    def __init__(self, input_dim, transformer_input_dim, num_layers=1, nhead=8, dropout=0.1):
        super().__init__()
        if input_dim != transformer_input_dim:
            self.input_proj = nn.Sequential(
                nn.Linear(input_dim, transformer_input_dim),
                nn.LayerNorm(transformer_input_dim),
                nn.GELU(),
                nn.Dropout(dropout * 0.5),
                nn.Linear(transformer_input_dim, transformer_input_dim),
            )
        else:
            self.input_proj = nn.Identity()
        self.transformer = Encoder(
            dim=transformer_input_dim, depth=num_layers, heads=nhead, layer_dropout=dropout,
            attn_dropout=dropout, ff_dropout=dropout, attn_flash=True, rotary_pos_emb=True,
        )

    def forward(self, x):
        return self.transformer(self.input_proj(x))


class TimeDownsample(nn.Module):
    def __init__(self, dim_in, dim_out=None, kernel_size=5, stride=5, padding=0, dropout=0.1):
        super().__init__()
        self.dim_out = dim_out or dim_in
        self.depthwise_conv = nn.Conv1d(dim_in, dim_in, kernel_size=kernel_size, stride=stride,
                                        padding=padding, groups=dim_in, bias=False)
        self.pointwise_conv = nn.Conv1d(dim_in, self.dim_out, kernel_size=1, bias=False)
        self.pool = nn.AvgPool1d(kernel_size, stride, padding=padding)
        self.norm1 = nn.LayerNorm(self.dim_out)
        self.act1 = nn.GELU()
        self.dropout1 = nn.Dropout(dropout)
        self.residual_conv = nn.Conv1d(dim_in, self.dim_out, kernel_size=1, bias=False) if dim_in != self.dim_out else None

    def forward(self, x):  # [B, T, D_in] -> [B, T_down, D_out]
        x_c = self.pointwise_conv(self.depthwise_conv(x.transpose(1, 2)))
        res = self.pool(x.transpose(1, 2))
        if self.residual_conv is not None:
            res = self.residual_conv(res)
        return self.dropout1(self.act1(self.norm1((x_c + res).transpose(1, 2))))


class Model(nn.Module):
    def __init__(self, cfg: dict = CONFIG):
        super().__init__()
        self.input_norm = nn.LayerNorm(cfg["input_dim"])
        self.mixed_win_downsample = nn.Linear(cfg["input_dim_raw"], cfg["input_dim"])
        self.dataset_class_prefix = nn.Embedding(cfg["num_dataset_classes"], cfg["transformer_encoder_input_dim"])
        self.down_sample_conv = TimeDownsample(
            dim_in=cfg["input_dim"], dim_out=cfg["transformer_encoder_input_dim"],
            kernel_size=cfg["down_sample_conv_kernel_size"], stride=cfg["down_sample_conv_stride"],
            dropout=cfg["down_sample_conv_dropout"], padding=cfg["down_sample_conv_padding"],
        )
        self.transformer = WrapedTransformerEncoder(
            input_dim=cfg["transformer_encoder_input_dim"], transformer_input_dim=cfg["transformer_input_dim"],
            num_layers=cfg["num_transformer_layers"], nhead=cfg["transformer_nhead"], dropout=cfg["transformer_dropout"],
        )
        self.boundary_head = Head(cfg["transformer_input_dim"], 1)
        self.function_head = Head(cfg["transformer_input_dim"], cfg["num_classes"])

    @torch.no_grad()
    def logits(self, embeddings: torch.Tensor, dataset_id: int, allowed: torch.Tensor):
        """embeddings [1, T, 4096] at 25 Hz -> (function logits [T', C] masked to `allowed`, boundary logits [T'])."""
        x = self.input_norm(self.mixed_win_downsample(embeddings))
        x = self.down_sample_conv(x)
        prefix = self.dataset_class_prefix(torch.tensor([dataset_id], device=x.device))
        x = self.transformer(x + prefix.unsqueeze(1))
        fn = self.function_head(x)[0]
        fn = fn.masked_fill(~allowed.to(fn.device)[None, :], -float("inf"))
        return fn, self.boundary_head(x).squeeze(-1)[0]
