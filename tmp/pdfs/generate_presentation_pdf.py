from __future__ import annotations

import html
import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


NAVY = colors.HexColor("#13213A")
BLUE = colors.HexColor("#2368D1")
CYAN = colors.HexColor("#4DA3FF")
INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5D6A7D")
PALE = colors.HexColor("#EDF4FF")
PALE_GRAY = colors.HexColor("#F5F7FA")
RULE = colors.HexColor("#D9E1EC")


def normalize_text(value: str) -> str:
    replacements = {
        "\u2013": "-",
        "\u2014": "-",
        "\u2011": "-",
        "\u2212": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2192": "->",
        "\u2265": ">=",
        "\u00d7": "x",
        "\u2026": "...",
        "\u00b7": "-",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    return value


def inline_markup(value: str) -> str:
    value = html.escape(normalize_text(value.strip()))
    value = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", value)
    value = re.sub(r"`([^`]+)`", r"<font name='Courier'>\1</font>", value)
    return value


def plain_heading(value: str) -> str:
    return normalize_text(re.sub(r"[*_`]", "", value)).strip()


class PresentationDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="content",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(
            [
                PageTemplate(id="cover", frames=[frame], onPage=self.draw_cover_page),
                PageTemplate(id="body", frames=[frame], onPage=self.draw_body_page),
            ]
        )
        self._bookmark_count = 0

    def draw_cover_page(self, canvas, doc):
        canvas.saveState()
        width, height = A4
        canvas.setFillColor(NAVY)
        canvas.rect(0, 0, width, height, stroke=0, fill=1)
        canvas.setFillColor(BLUE)
        canvas.rect(0, height - 16 * mm, width, 16 * mm, stroke=0, fill=1)
        canvas.setFillColor(CYAN)
        canvas.circle(width - 24 * mm, 24 * mm, 9 * mm, stroke=0, fill=1)
        canvas.setStrokeColor(colors.Color(1, 1, 1, alpha=0.2))
        canvas.setLineWidth(1)
        canvas.line(22 * mm, 28 * mm, width - 40 * mm, 28 * mm)
        canvas.restoreState()

    def draw_body_page(self, canvas, doc):
        canvas.saveState()
        width, height = A4
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.6)
        canvas.line(doc.leftMargin, height - 18 * mm, width - doc.rightMargin, height - 18 * mm)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(NAVY)
        canvas.drawString(doc.leftMargin, height - 14 * mm, "SAFESCROLL")
        label = "Industry Guide Presentation Script"
        label_width = stringWidth(label, "Helvetica", 8)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(width - doc.rightMargin - label_width, height - 14 * mm, label)
        canvas.setStrokeColor(RULE)
        canvas.line(doc.leftMargin, 16 * mm, width - doc.rightMargin, 16 * mm)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(doc.leftMargin, 11 * mm, "On-device, privacy-first content moderation")
        page_label = f"Page {canvas.getPageNumber() - 1}"
        page_width = stringWidth(page_label, "Helvetica", 8)
        canvas.drawString(width - doc.rightMargin - page_width, 11 * mm, page_label)
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        style_name = flowable.style.name
        # The source title is represented by the cover rather than a body H1,
        # so H2 sections are the first outline level. A later H1 begins the
        # Q&A chapter at the same top level.
        levels = {"Chapter": 0, "Section": 0, "Subsection": 1}
        if style_name not in levels:
            return
        level = levels[style_name]
        text = flowable.getPlainText()
        self._bookmark_count += 1
        key = f"heading-{self._bookmark_count}"
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(text, key, level=level, closed=False)
        self.notify("TOCEntry", (level, text, self.page))


def build_styles():
    base = getSampleStyleSheet()
    return {
        "cover_kicker": ParagraphStyle(
            "CoverKicker",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=10,
            leading=13,
            textColor=CYAN,
            spaceAfter=7 * mm,
            alignment=TA_LEFT,
        ),
        "cover_title": ParagraphStyle(
            "CoverTitle",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=31,
            leading=35,
            textColor=colors.white,
            alignment=TA_LEFT,
            spaceAfter=8 * mm,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=14,
            leading=21,
            textColor=colors.HexColor("#D8E6FF"),
            spaceAfter=17 * mm,
        ),
        "cover_meta": ParagraphStyle(
            "CoverMeta",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            leading=16,
            textColor=colors.HexColor("#B9C9DF"),
        ),
        "toc_title": ParagraphStyle(
            "TOCTitle",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=22,
            leading=27,
            textColor=NAVY,
            spaceAfter=7 * mm,
        ),
        "chapter": ParagraphStyle(
            "Chapter",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=21,
            leading=25,
            textColor=NAVY,
            spaceBefore=5 * mm,
            spaceAfter=5 * mm,
            keepWithNext=True,
        ),
        "section": ParagraphStyle(
            "Section",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=14.5,
            leading=18,
            textColor=BLUE,
            spaceBefore=5 * mm,
            spaceAfter=2.5 * mm,
            keepWithNext=True,
        ),
        "subsection": ParagraphStyle(
            "Subsection",
            parent=base["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=11.5,
            leading=15,
            textColor=NAVY,
            spaceBefore=3.5 * mm,
            spaceAfter=1.5 * mm,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=14.2,
            textColor=INK,
            alignment=TA_LEFT,
            spaceAfter=2.5 * mm,
            allowWidows=0,
            allowOrphans=0,
        ),
        "meta": ParagraphStyle(
            "Meta",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=13.5,
            textColor=MUTED,
            leftIndent=4 * mm,
            borderColor=RULE,
            borderWidth=0.7,
            borderPadding=7,
            backColor=PALE_GRAY,
            spaceAfter=2.5 * mm,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=14.2,
            textColor=INK,
            leftIndent=6 * mm,
            firstLineIndent=-4 * mm,
            bulletIndent=1 * mm,
            spaceAfter=1.5 * mm,
        ),
        "quote": ParagraphStyle(
            "Quote",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=16,
            textColor=NAVY,
            leftIndent=7 * mm,
            rightIndent=7 * mm,
            borderColor=CYAN,
            borderWidth=0,
            borderPadding=8,
            backColor=PALE,
            spaceBefore=2 * mm,
            spaceAfter=4 * mm,
        ),
        "stage": ParagraphStyle(
            "StageDirection",
            parent=base["BodyText"],
            fontName="Helvetica-BoldOblique",
            fontSize=9,
            leading=13,
            textColor=BLUE,
            leftIndent=5 * mm,
            rightIndent=5 * mm,
            borderColor=colors.HexColor("#B9D4FF"),
            borderWidth=0.6,
            borderPadding=7,
            backColor=PALE,
            spaceBefore=2 * mm,
            spaceAfter=3 * mm,
        ),
        "code": ParagraphStyle(
            "Code",
            parent=base["Code"],
            fontName="Courier",
            fontSize=8.2,
            leading=11.5,
            textColor=INK,
            leftIndent=4 * mm,
            rightIndent=4 * mm,
            borderColor=RULE,
            borderWidth=0.5,
            borderPadding=8,
            backColor=PALE_GRAY,
            spaceBefore=2 * mm,
            spaceAfter=4 * mm,
        ),
    }


def paragraph_from_buffer(buffer: list[str], styles, story):
    if not buffer:
        return
    raw = " ".join(part.strip() for part in buffer).strip()
    buffer.clear()
    if not raw:
        return
    if raw.startswith("**[") and raw.endswith("]**"):
        content = raw[2:-2]
        story.append(Paragraph(inline_markup(content), styles["stage"]))
        return
    if raw.startswith("**Recommended duration:") or raw.startswith("**Full duration:") or raw.startswith("**12-15 minute route:") or raw.startswith("**How to use:"):
        story.append(Paragraph(inline_markup(raw), styles["meta"]))
        return
    story.append(Paragraph(inline_markup(raw), styles["body"]))


def parse_markdown(markdown: str, styles):
    lines = normalize_text(markdown).splitlines()
    story = []
    buffer: list[str] = []
    in_code = False
    code_lines: list[str] = []
    skipped_title = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            paragraph_from_buffer(buffer, styles, story)
            if in_code:
                story.append(Preformatted("\n".join(code_lines), styles["code"] ))
                code_lines = []
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(line.rstrip())
            continue
        if not stripped:
            paragraph_from_buffer(buffer, styles, story)
            continue
        if stripped == "---":
            paragraph_from_buffer(buffer, styles, story)
            story.append(Spacer(1, 1.5 * mm))
            continue
        if stripped.startswith("# "):
            paragraph_from_buffer(buffer, styles, story)
            heading = plain_heading(stripped[2:])
            if not skipped_title:
                skipped_title = True
                continue
            story.append(PageBreak())
            story.append(Paragraph(html.escape(heading), styles["chapter"]))
            continue
        if stripped.startswith("## "):
            paragraph_from_buffer(buffer, styles, story)
            heading = plain_heading(stripped[3:])
            story.append(Paragraph(html.escape(heading), styles["section"]))
            continue
        if stripped.startswith("### "):
            paragraph_from_buffer(buffer, styles, story)
            heading = plain_heading(stripped[4:])
            story.append(Paragraph(html.escape(heading), styles["subsection"]))
            continue
        if stripped.startswith("> "):
            paragraph_from_buffer(buffer, styles, story)
            story.append(Paragraph(inline_markup(stripped[2:]), styles["quote"]))
            continue
        if re.match(r"^[-*]\s+", stripped):
            paragraph_from_buffer(buffer, styles, story)
            body = re.sub(r"^[-*]\s+", "", stripped)
            story.append(Paragraph(inline_markup(body), styles["bullet"], bulletText="-"))
            continue
        buffer.append(stripped)

    paragraph_from_buffer(buffer, styles, story)
    if code_lines:
        story.append(Preformatted("\n".join(code_lines), styles["code"]))
    return story


def create_cover(styles):
    story = [Spacer(1, 42 * mm)]
    story.append(Paragraph("PROJECT PRESENTATION", styles["cover_kicker"]))
    story.append(Paragraph("SafeScroll", styles["cover_title"]))
    story.append(
        Paragraph(
            "Industry Guide Presentation Script<br/>"
            "On-device, privacy-first content moderation for the web",
            styles["cover_subtitle"],
        )
    )
    story.append(
        Paragraph(
            "Full presentation: 22-25 minutes<br/>"
            "Includes demonstration cues, evaluation, limitations, future scope, and viva answers<br/><br/>"
            "Prepared 9 October 2026",
            styles["cover_meta"],
        )
    )
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())
    return story


def create_toc(styles):
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle(
            "TOCLevel1",
            fontName="Helvetica-Bold",
            fontSize=10.5,
            leading=16,
            leftIndent=0,
            firstLineIndent=0,
            textColor=NAVY,
            spaceBefore=2,
        ),
        ParagraphStyle(
            "TOCLevel2",
            fontName="Helvetica",
            fontSize=9.5,
            leading=14,
            leftIndent=8 * mm,
            firstLineIndent=0,
            textColor=INK,
        ),
        ParagraphStyle(
            "TOCLevel3",
            fontName="Helvetica",
            fontSize=8.5,
            leading=12,
            leftIndent=15 * mm,
            firstLineIndent=0,
            textColor=MUTED,
        ),
    ]
    return [
        Paragraph("Contents", styles["toc_title"]),
        Paragraph(
            "Use the full script as written, or follow the 12-15 minute route noted at the beginning.",
            styles["body"],
        ),
        Spacer(1, 3 * mm),
        toc,
        PageBreak(),
    ]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: generate_presentation_pdf.py input.md output.pdf")
    source = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    styles = build_styles()
    doc = PresentationDocTemplate(
        str(output),
        pagesize=A4,
        title="SafeScroll Industry Guide Presentation Script",
        author="SafeScroll Project",
        subject="Industry guide project presentation",
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=24 * mm,
        bottomMargin=22 * mm,
    )

    story = []
    story.extend(create_cover(styles))
    story.append(Paragraph("Contents", styles["toc_title"]))
    story.append(
        Paragraph(
            "Use the full script as written, or follow the 12-15 minute route noted at the beginning.",
            styles["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle("TOC1", fontName="Helvetica-Bold", fontSize=10, leading=15, textColor=NAVY),
        ParagraphStyle("TOC2", fontName="Helvetica", fontSize=9, leading=13, leftIndent=7 * mm, textColor=INK),
        ParagraphStyle("TOC3", fontName="Helvetica", fontSize=8, leading=11, leftIndent=14 * mm, textColor=MUTED),
    ]
    story.extend([toc, PageBreak()])
    story.extend(parse_markdown(source.read_text(encoding="utf-8"), styles))

    doc.multiBuild(story)
    print(output)


if __name__ == "__main__":
    main()
