"""三档参数。比例和阈值与清洗方案一致。"""

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Preset:
    name: str
    close_frac: float
    sauvola_k: float
    bh_percentile: float
    keep_dark_pct: float
    sharpen: float
    white_target: float
    deskew: bool
    crop_text_block: bool
    keep_gutter: bool
    strong_destain: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


PRESETS: dict[str, Preset] = {
    "clean": Preset(
        name="clean",
        close_frac=0.04,
        sauvola_k=0.15,
        bh_percentile=97,
        keep_dark_pct=60,
        sharpen=0.6,
        white_target=252,
        deskew=True,
        crop_text_block=False,
        # 不凭文字列间距推断书缝；原图没有折痕时不能凭空生成竖向暗带。
        keep_gutter=False,
    ),
    "aged": Preset(
        name="aged",
        close_frac=0.06,
        sauvola_k=0.20,
        bh_percentile=96,
        keep_dark_pct=55,
        sharpen=0.72,
        white_target=250,
        deskew=True,
        crop_text_block=False,
        # 不凭文字列间距推断书缝；原图没有折痕时不能凭空生成竖向暗带。
        keep_gutter=False,
    ),
    "damaged": Preset(
        name="damaged",
        close_frac=0.05,
        sauvola_k=0.18,
        bh_percentile=97,
        keep_dark_pct=60,
        sharpen=0.5,
        white_target=248,
        deskew=False,
        crop_text_block=True,
        keep_gutter=False,
    ),
}


def odd_clamp(value: float, lo: int, hi: int) -> int:
    """把核大小收进区间，并收成奇数。"""
    v = int(round(value))
    v = min(max(v, lo), hi)
    if v % 2 == 0:
        v = v + 1 if v < hi else v - 1
    return v
