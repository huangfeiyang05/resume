#!/usr/bin/env python3
"""Create editable Chinese resume templates adapted from Reactive Resume.

Design references: Onyx, Azurill and Chikorita (MIT).
The templates contain prompts only. They do not represent a person's facts.
Run with the Codex workspace Python runtime; optional --render creates the
website preview PNG assets with the bundled document renderer.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src/static/resume-templates"
OUTPUTS = ROOT / "outputs/简历Word模板"
RENDERS = ROOT / ".data/layout-qa/open-source-adaptations"
RUNTIME = Path("/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies")
RENDERER = Path("/Users/mac/.codex/plugins/cache/openai-primary-runtime/documents/26.1013.11914/skills/documents/render_docx.py")
FONT_CONFIG = ROOT / ".data/layout-qa/word/fonts.conf"
FONT = "Hiragino Sans GB"
INK = "20252B"
MUTED = "64717D"
BLUE = "347B9C"
NAVY = "17324D"

MIT_LICENSE = """MIT License

Copyright (c) 2026 Amruth Pillai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def text(run, size=10, bold=False, color=INK):
    run.font.name = FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)
    rf = run._element.get_or_add_rPr().get_or_add_rFonts()
    for key in ("ascii", "hAnsi", "eastAsia", "cs"):
        rf.set(qn(f"w:{key}"), FONT)
    return run


def format_p(p, *, before=0, after=3, line=14.5, keep=False, align=None):
    pf = p.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = Pt(line)
    pf.keep_with_next = keep
    pf.widow_control = True
    if align is not None:
        p.alignment = align
    return p


def paragraph(parent, value="", *, size=10, bold=False, color=INK, **fmt):
    # Reuse the mandatory first empty paragraph of a new table cell.
    if hasattr(parent, "_tc") and len(parent.paragraphs) == 1 and not parent.paragraphs[0].text and len(parent.tables) == 0:
        p = parent.paragraphs[0]
    else:
        p = parent.add_paragraph()
    format_p(p, **fmt)
    if value:
        text(p.add_run(value), size, bold, color)
    return p


def cell_padding(cell, *, top=0, left=0, bottom=0, right=0):
    pr = cell._tc.get_or_add_tcPr()
    for old in list(pr.findall(qn("w:tcMar"))):
        pr.remove(old)
    mar = OxmlElement("w:tcMar")
    for edge, value in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:w"), str(round(value * 1440 / 25.4)))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    pr.append(mar)


def cell_fill(cell, color):
    pr = cell._tc.get_or_add_tcPr()
    shade = OxmlElement("w:shd")
    shade.set(qn("w:val"), "clear")
    shade.set(qn("w:fill"), color)
    pr.append(shade)


def table(parent, widths, *, min_height=None):
    t = parent.add_table(rows=1, cols=len(widths))
    t.autofit = False
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    pr = t._tbl.tblPr
    tw = pr.find(qn("w:tblW"))
    tw.set(qn("w:w"), str(round(sum(widths) * 1440 / 25.4)))
    tw.set(qn("w:type"), "dxa")
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "nil")
        borders.append(el)
    pr.append(borders)
    if min_height is not None:
        t.rows[0].height = Mm(min_height)
        t.rows[0].height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
    for column, cell, width in zip(t.columns, t.rows[0].cells, widths):
        column.width = Mm(width)
        cell.width = Mm(width)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
        cell_padding(cell)
        format_p(cell.paragraphs[0], after=0, line=1)
    return t


def rule(p, color, *, size=5, space=4, edge="bottom"):
    borders = OxmlElement("w:pBdr")
    el = OxmlElement(f"w:{edge}")
    for k, v in {"val": "single", "sz": str(size), "space": str(space), "color": color}.items():
        el.set(qn(f"w:{k}"), v)
    borders.append(el)
    p._p.get_or_add_pPr().append(borders)


def section(parent, title, *, accent=INK, kind="classic", side=False):
    p = paragraph(parent, title, size=11 if not side else 10.5, bold=True,
                  color="FFFFFF" if side and kind == "business" else accent,
                  before=12 if side else 10, after=6, line=16, keep=True)
    p.style = "Heading 1"
    # Explicit formatting preserves the chosen style when a Word theme changes.
    for r in p.runs:
        text(r, 11 if not side else 10.5, True, "FFFFFF" if side and kind == "business" else accent)
    if kind == "classic":
        rule(p, "B9BDC2", size=4, space=3)
    elif kind == "business":
        rule(p, "6E879E" if side else NAVY, size=4, space=4)
    elif not side:
        # Azurill's timeline is translated to an editable paragraph border.
        rule(p, "9CBFD0", size=5, space=5, edge="left")
        p.paragraph_format.left_indent = Mm(2.5)
    return p


def entry_title(parent, left, date, width, *, accent=INK, size=10):
    p = paragraph(parent, size=size, after=2.5, line=14.5, keep=True)
    p.paragraph_format.tab_stops.add_tab_stop(Mm(width), WD_TAB_ALIGNMENT.RIGHT)
    text(p.add_run(left), size, True, accent)
    text(p.add_run("\t" + date), 9.5, False, MUTED)
    return p


def labelled(parent, label, value, *, color=INK, size=10, after=3):
    p = paragraph(parent, size=size, after=after, line=14.5)
    text(p.add_run(label), size, True, color)
    text(p.add_run(value), size, False, color)
    return p


def bullet(parent, value, *, size=10, color=INK):
    p = paragraph(parent, size=size, after=3, line=14.5)
    p.paragraph_format.left_indent = Mm(3)
    p.paragraph_format.first_line_indent = Mm(-3)
    text(p.add_run("•  " + value), size, False, color)
    return p


def photo(parent, *, fill="F4F6F8", border="BBC7D0"):
    p = paragraph(parent, after=0, line=1)
    t = table(parent, [30])
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.rows[0].height = Mm(40)
    t.rows[0].height_rule = WD_ROW_HEIGHT_RULE.EXACTLY
    c = t.cell(0, 0)
    c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    cell_fill(c, fill)
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        for k, v in {"val": "single", "sz": "5", "color": border}.items():
            el.set(qn(f"w:{k}"), v)
        borders.append(el)
    c._tc.get_or_add_tcPr().append(borders)
    paragraph(c, "证件照", size=9.5, color=MUTED, after=4, line=14,
              align=WD_ALIGN_PARAGRAPH.CENTER)
    paragraph(c, "30 × 40 mm", size=9.5, color=MUTED, after=0, line=13,
              align=WD_ALIGN_PARAGRAPH.CENTER)
    # Word requires a paragraph after a nested table; keep that structural
    # paragraph tiny so it does not inflate the identity block.
    for empty in parent.paragraphs:
        if not empty.text:
            format_p(empty, after=0, line=1)
            empty.paragraph_format.space_before = Pt(0)
            text(empty.add_run(""), 1)
    return t


def identity(parent, *, accent=INK, centered=False, compact=False):
    align = WD_ALIGN_PARAGRAPH.CENTER if centered else WD_ALIGN_PARAGRAPH.LEFT
    p = paragraph(parent, "[姓名]", size=28 if not compact else 26, bold=True,
                  color=INK, after=5, line=35, keep=True, align=align)
    p.style = "Title"
    text(p.runs[0], 28 if not compact else 26, True, INK)
    paragraph(parent, "[目标岗位]", size=12, bold=True, color=accent,
              after=9, line=17, keep=True, align=align)
    paragraph(parent, "手机 [手机号]   ·   邮箱 [电子邮箱]", size=9.5, color=MUTED,
              after=3, line=14, keep=True, align=align)
    paragraph(parent, "城市 [意向城市]   ·   到岗 [可到岗时间]", size=9.5, color=MUTED,
              after=3, line=14, keep=True, align=align)
    paragraph(parent, "主页 [作品集或个人主页，可选]", size=9.5, color=MUTED,
              after=5, line=14, align=align)


def education(parent, width, *, accent=INK, kind="classic"):
    section(parent, "教育背景", accent=accent, kind=kind)
    entry_title(parent, "[学校全称]", "[入学年月] - [毕业年月]", width, accent=accent)
    paragraph(parent, "[专业名称]  ·  [学历或学位]", bold=True, after=3, line=14.5)
    labelled(parent, "相关课程：", "[与岗位相关的课程或研究方向]。")
    labelled(parent, "学业成果：", "[真实成果；GPA、排名仅在有依据时填写]。")


def experience(parent, width, *, accent=INK, kind="classic", compact=False):
    section(parent, "工作或实习经历", accent=accent, kind=kind)
    entry_title(parent, "[单位全称]", "[开始年月] - [结束年月]", width, accent=accent)
    paragraph(parent, "[工作或实习岗位]  /  [参与的项目或业务名称]", bold=True,
              after=5, line=14.5, keep=True)
    labelled(parent, "项目描述：", "面向[服务对象]，围绕[实际问题]开展[具体工作]。")
    labelled(parent, "职责范围：", "负责[本人承担的环节]，与[协作对象]完成[任务]。")
    labelled(parent, "技术栈：", "[实际使用的技术、软件、工具或专业方法]。")
    bullet(parent, "[工作重点一]：采用[实际方法]完成[本人动作]，交付[可核实产出]。")
    bullet(parent, "[工作重点二]：负责[流程或模块]，通过[真实依据]说明效果。")
    if not compact:
        bullet(parent, "[工作重点三]：沉淀[文档或方案]，说明适用场景与本人贡献。")


def projects(parent, width, *, accent=INK, kind="classic", compact=False):
    section(parent, "项目经历", accent=accent, kind=kind)
    entry_title(parent, "[项目名称]", "[开始年月] - [结束年月]", width, accent=accent)
    paragraph(parent, "[项目类型]  /  [本人角色]", bold=True, after=5, line=14.5, keep=True)
    labelled(parent, "项目描述：", "面向[用户或研究对象]，解决[问题]，包含[核心内容]。")
    labelled(parent, "职责范围：", "独立负责或参与[具体范围]，完成[本人交付物]。")
    labelled(parent, "技术栈：", "[实际使用的语言、框架、软件、设备或专业方法]。")
    bullet(parent, "[核心工作一]：基于[真实需求]完成[任务]，说明关键方法。")
    bullet(parent, "[核心工作二]：针对[难点]采取[措施]，通过[真实反馈]说明结果。")
    if not compact:
        bullet(parent, "[项目产出]：交付[作品、报告、系统或方案]；可附真实链接。")


def skills(parent, *, accent=INK, kind="classic", side=False):
    section(parent, "专业技能", accent=accent, kind=kind, side=side)
    color = "DCE6EF" if side and kind == "business" else INK
    if side:
        paragraph(parent, "[专业能力或方法]", bold=True, color=color, after=4, line=14.5)
        paragraph(parent, "[实际应用场景与任务]", color=color, after=8, line=14.5)
        paragraph(parent, "[工具与软件]", bold=True, color=color, after=4, line=14.5)
        paragraph(parent, "[使用过的工具及用途]", color=color, after=8, line=14.5)
        paragraph(parent, "[语言能力]", bold=True, color=color, after=4, line=14.5)
        paragraph(parent, "[真实成绩或使用场景]", color=color, after=2, line=14.5)
    else:
        labelled(parent, "专业能力：", "[技能或方法]，用于[真实场景]，完成[具体任务]。")
        labelled(parent, "工具与语言：", "[工具与用途]；[语言能力及有依据的成绩或使用场景]。")


def credentials(parent, *, accent=INK, kind="classic", side=False):
    section(parent, "证书与荣誉", accent=accent, kind=kind, side=side)
    color = "DCE6EF" if side and kind == "business" else INK
    if not side:
        paragraph(parent, "[证书或荣誉名称]  ·  [颁发机构或获奖级别]  ·  [取得年月]",
                  color=color, after=0, line=14.5)
        return
    paragraph(parent, "[证书或荣誉名称]", bold=True, color=color, after=3, line=14.5)
    paragraph(parent, "[颁发机构或获奖级别]", color=color, after=3, line=14.5)
    paragraph(parent, "[取得年月]", size=9.5, color="AFC2D3" if kind == "business" and side else MUTED,
              after=0, line=14)


def self_review(parent, *, accent=INK, kind="classic", side=False):
    section(parent, "自我评价", accent=accent, kind=kind, side=side)
    color = "DCE6EF" if side and kind == "business" else INK
    if not side:
        paragraph(parent, "[围绕目标岗位写1—2项优势，用真实事例佐证；无依据时不写数字或熟练程度。]",
                  color=color, after=0, line=14.5)
        return
    paragraph(parent, "[围绕目标岗位写1—2项优势，用真实学习、实习或项目事例佐证。]",
              color=color, after=5, line=14.5)
    paragraph(parent, "[仅填写真实信息，无依据时不写数字或熟练程度。]",
              size=9.5, color="AFC2D3" if kind == "business" and side else MUTED,
              after=0, line=14)


def base_document(title, reference, *, margins=(13, 15, 13, 15)):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.top_margin, sec.right_margin, sec.bottom_margin, sec.left_margin = map(Mm, margins)
    sec.header_distance = sec.footer_distance = Mm(0)
    for name in ("Normal", "Title", "Subtitle", "Heading 1", "Heading 2"):
        style = doc.styles[name]
        style.font.name = FONT
        style.font.size = Pt(10)
        style.font.color.rgb = RGBColor.from_string(INK)
        style.paragraph_format.space_before = Pt(0)
        style.paragraph_format.space_after = Pt(0)
        rf = style._element.get_or_add_rPr().get_or_add_rFonts()
        rf.set(qn("w:eastAsia"), FONT)
        pp = style._element.find(qn("w:pPr"))
        if pp is not None:
            for bdr in list(pp.findall(qn("w:pBdr"))):
                pp.remove(bdr)
    doc.core_properties.title = title + "简历模板"
    doc.core_properties.subject = "教育背景 专业技能 工作或实习经历 项目经历 证书与荣誉 自我评价"
    doc.core_properties.author = ""
    doc.core_properties.last_modified_by = ""
    doc.core_properties.keywords = "可编辑 占位简历模板"
    # Set the OOXML description directly: python-docx's convenience property
    # imposes a 255-character limit which is too short for the MIT notice.
    description = doc.core_properties._element.find(qn("dc:description"))
    if description is None:
        description = OxmlElement("dc:description")
        doc.core_properties._element.append(description)
    description.text = (
        f"Design adapted from {reference}, Reactive Resume.\n"
        "https://github.com/reactive-resume/reactive-resume\n\n" + MIT_LICENSE
    )
    return doc


def classic():
    doc = base_document("经典简约", "Onyx")
    header = table(doc, [142, 8, 30], min_height=40)
    left, _, right = header.rows[0].cells
    identity(left, centered=True)
    photo(right)
    # Onyx's broad identity area and fine section rules retain its restrained hierarchy.
    p = paragraph(doc, after=1, line=1)
    rule(p, INK, size=7, space=5)
    education(doc, 180)
    skills(doc)
    experience(doc, 180, compact=True)
    projects(doc, 180, compact=True)
    credentials(doc)
    self_review(doc)
    return doc


def modern():
    doc = base_document("现代留白", "Azurill", margins=(12, 12, 12, 12))
    layout = table(doc, [54, 132], min_height=240)
    side, main = layout.rows[0].cells
    cell_fill(side, "EAF3F8")
    cell_padding(side, top=8, left=6, bottom=9, right=6)
    cell_padding(main, top=6, left=10, bottom=9, right=0)
    photo(side, fill="F8FBFE", border="ADC9D9")
    skills(side, accent=BLUE, kind="modern", side=True)
    credentials(side, accent=BLUE, kind="modern", side=True)
    self_review(side, accent=BLUE, kind="modern", side=True)
    identity(main, accent=BLUE, centered=True, compact=True)
    education(main, 122, accent=BLUE, kind="modern")
    experience(main, 122, accent=BLUE, kind="modern", compact=True)
    projects(main, 122, accent=BLUE, kind="modern", compact=True)
    format_p(doc.add_paragraph(), after=0, line=1)
    return doc


def business():
    doc = base_document("专业商务", "Chikorita", margins=(0, 0, 0, 0))
    layout = table(doc, [145, 65], min_height=265)
    main, side = layout.rows[0].cells
    cell_padding(main, top=16, left=15, bottom=12, right=10)
    cell_padding(side, top=16, left=8, bottom=12, right=9)
    cell_fill(side, NAVY)
    identity(main, accent=NAVY, compact=True)
    education(main, 120, accent=NAVY, kind="business")
    experience(main, 120, accent=NAVY, kind="business", compact=True)
    projects(main, 120, accent=NAVY, kind="business", compact=True)
    photo(side, fill="EDF2F6", border="A6BCCF")
    skills(side, accent=NAVY, kind="business", side=True)
    credentials(side, accent=NAVY, kind="business", side=True)
    self_review(side, accent=NAVY, kind="business", side=True)
    format_p(doc.add_paragraph(), after=0, line=1)
    return doc


def render_asset(path):
    render_dir = RENDERS / path.stem
    render_dir.mkdir(parents=True, exist_ok=True)
    # Replace each generated preview set instead of retaining old later pages.
    for previous_page in render_dir.glob("page-*.png"):
        previous_page.unlink()
    for previous_asset in ASSETS.glob(f"{path.stem}-page-*.png"):
        previous_asset.unlink()
    env = os.environ.copy()
    env["FONTCONFIG_FILE"] = str(FONT_CONFIG)
    env["PATH"] = str(RUNTIME / "bin/override") + os.pathsep + env.get("PATH", "")
    subprocess.run(
        [str(RUNTIME / "python/bin/python3"), str(RENDERER), str(path),
         "--output_dir", str(render_dir), "--width", "1414", "--height", "2000"],
        env=env, check=True,
    )
    # The website thumbnail is the first page, as for the existing template assets.
    shutil.copyfile(render_dir / "page-1.png", path.with_suffix(".png"))
    # Preserve every later generated page for clients that display a long
    # editable resume; this is asset generation rather than a layout review.
    for page in sorted(render_dir.glob("page-*.png")):
        page_number = page.stem.removeprefix("page-")
        if page_number != "1":
            shutil.copyfile(page, ASSETS / f"{path.stem}-page-{page_number}.png")
    print("Generated pages: " + ", ".join(str(p) for p in sorted(render_dir.glob("page-*.png"))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render", action="store_true", help="Generate website PNG assets after writing Word files")
    args = parser.parse_args()
    ASSETS.mkdir(parents=True, exist_ok=True)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    RENDERS.mkdir(parents=True, exist_ok=True)
    templates = [
        ("classic-onyx", "01_经典简约.docx", classic),
        ("blue-azurill", "02_现代留白.docx", modern),
        ("navy-chikorita", "03_专业商务.docx", business),
    ]
    for asset_id, download_name, create in templates:
        path = ASSETS / f"{asset_id}.docx"
        create().save(path)
        shutil.copyfile(path, OUTPUTS / download_name)
        print(f"Created {path}")
        if args.render:
            render_asset(path)
            print(f"Generated {path.with_suffix('.png')}")


if __name__ == "__main__":
    main()
