"""三档参数。比例和阈值与清洗方案一致。

denoise / stain 是审阅页滑块的覆盖位（0~1），有默认值，三档字面量不写也行；
zupu_clean.py 会用滑块值 dataclasses.replace 掉对应字段。
"""

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
    # 审阅页滑块覆盖位：去污渍力度（连通域剔除）、去渍力度（彩色黄褐斑抑制）
    denoise: float = 0.5
    stain: float = 0.4

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
