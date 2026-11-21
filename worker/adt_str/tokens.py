"""ADT_STR output tokens -> hits (upstream modules/midi_tokenizer.py layout).

0 silence, 1 pad, 2 BOS, 3 EOS; 4..299 onset time in 10 ms steps from the window start;
300..399 class id (+300); 400..527 velocity (+400). A hit is exactly time, class, velocity in that
order. Unlike upstream's decoder (which pairs onsets, classes and velocities by insertion order),
an incomplete or out-of-order triple is skipped on its own and cannot shift the hits after it.
"""
BOS, EOS = 2, 3
TIME, CLASS, VELOCITY, END = 4, 300, 400, 528


def parse(tokens) -> list[tuple[float, int, int]]:
    """One window's tokens -> [(onset s from window start, class id, velocity)], in token order."""
    out = []
    seq = [int(t) for t in tokens]
    i = 0
    while i < len(seq):
        t = seq[i]
        if t == EOS:
            break
        if TIME <= t < CLASS and i + 2 < len(seq):
            c, v = seq[i + 1], seq[i + 2]
            if CLASS <= c < VELOCITY and VELOCITY <= v < END:
                out.append(((t - TIME) / 100, c - CLASS, v - VELOCITY))
                i += 3
                continue
        i += 1
    return out


def truncated(tokens) -> bool:
    """Whether decoding stopped at the length cap instead of at EOS."""
    return EOS not in [int(t) for t in tokens[1:]]
