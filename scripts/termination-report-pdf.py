# Builds the Splash-branded Employee Termination Report (2026-11-15): the old
# plain report rebuilt on the Employment Termination Checklist's letterhead
# (same logo, navy tagline + rule, Times body, navy footer address).
#
#   python scripts/termination-report-pdf.py OUT.pdf LOGO.jpg
#
# LOGO.jpg is the checklist PDF's embedded logo (400x143 JPEG). Needs PyMuPDF
# and the Windows Times New Roman / Arial fonts. Also writes report_spots.json:
# the box positions scripts/gen-termination.ts uses (REPORT_BOXES) -- if the
# layout here changes, copy the new numbers there and re-run it.

import fitz, sys

OUT = sys.argv[1]
LOGO = sys.argv[2]
NAVY = (0, 0, 0.502)
RED = (0.86, 0.1, 0.1)
BLACK = (0, 0, 0)

doc = fitz.open()
p = doc.new_page(width=612, height=792)
FONTS = {"tiro": "times.ttf", "tibo": "timesbd.ttf", "tiit": "timesi.ttf", "helv": "arial.ttf"}
OBJ = {k: fitz.Font(fontfile="C:/Windows/Fonts/" + v) for k, v in FONTS.items()}
for k, v in FONTS.items():
    p.insert_font(fontname="F" + k, fontfile="C:/Windows/Fonts/" + v)

def text(x, y, s, font="tiro", size=12, color=BLACK):
    p.insert_text((x, y), s, fontname="F" + font, fontsize=size, color=color)

def width(s, font="tiro", size=12):
    return OBJ[font].text_length(s, fontsize=size)

def line(x0, x1, y, color=BLACK, w=0.6):
    p.draw_line((x0, y), (x1, y), color=color, width=w)

LAST_BOX = []
def box(x, y):  # y = text baseline; box sits like the checklist's (12.9 x 14.25)
    p.draw_rect(fitz.Rect(x, y - 11, x + 11, y + 1), color=BLACK, width=0.75)
    LAST_BOX.append((x, y - 11, 11, 12))
    return x + 15

def navy_bullet_line(y, parts):
    """Centered navy Arial line with red bullets between parts."""
    sep = "  •  "
    total = sum(width(t, "helv", 10) for t in parts) + width(sep, "helv", 10) * (len(parts) - 1)
    x = (612 - total) / 2
    for i, t in enumerate(parts):
        text(x, y, t, "helv", 10, NAVY); x += width(t, "helv", 10)
        if i < len(parts) - 1:
            text(x, y, sep, "helv", 10, RED); x += width(sep, "helv", 10)

# ---- letterhead (matches the Employment Termination Checklist) ----
p.insert_image(fitz.Rect(37.5, 63.3, 222.45, 133.3), filename=LOGO)
def right_tag(y, parts):
    sep = " • "
    total = sum(width(t, "helv", 10) for t in parts) + width(sep, "helv", 10) * (len(parts) - 1)
    x = 571.25 - total - 4
    for i, t in enumerate(parts):
        text(x, y, t, "helv", 10, NAVY); x += width(t, "helv", 10)
        if i < len(parts) - 1:
            text(x, y, sep, "helv", 10, RED); x += width(sep, "helv", 10)
right_tag(112, ["HAND WASH", "EXPRESS WASH"])
line(214.3, 571.25, 116, NAVY, 0.75)
right_tag(130, ["FULL & EXPRESS DETAILING"])
navy_bullet_line(756, ["472 Wheelers Farm Rd. Suite 304 Milford, CT 06461", "Tel (203) 324-5400", "Fax (203) 325-9405"])

# ---- title ----
title = "Employee Termination Report"
tw = width(title, "tibo")
text((612 - tw) / 2, 172, title, "tibo")
line((612 - tw) / 2, (612 + tw) / 2, 174.5, BLACK, 1.1)

L, R = 72, 540
SPOTS = {}
def spot(name, x, y, w, h, **kw):
    SPOTS[name] = dict(x=round(x, 1), y=round(y, 1), w=round(w, 1), h=round(h, 1), **kw)

def field(x, y, label, x_end, name=None):
    text(x, y, label)
    x0 = x + width(label) + 4
    line(x0, x_end, y + 2)
    if name: spot(name, x0 + 2, y - 11, x_end - x0 - 2, 13, font_size=11)
    return x0

y = 214
field(L, y, "Employee:", 318, "employee"); field(332, y, "Location:", R, "site_name")
y += 30
field(L, y, "Date of Termination:", 318, "termination_date"); field(332, y, "Today’s Date:", R, "todays_date")
y += 30
field(L, y, "Manager approved by:", 400, "manager_approved_by")

y += 36
text(L, y, "Reason employee is being terminated:")
note = "(please be sure to have previous warnings documented, including final)"
y += 16
text(L, y, note, "tiit", 10.5)
y += 26
x = L
for opt, val in [("Fired", "fired"), ("Voluntarily Quit", "voluntary_quit"), ("Job Abandonment", "job_abandonment"), ("Medical Leave", "medical_leave")]:
    x = box(x, y); spot("reason=" + val, *LAST_BOX[-1]); text(x, y, opt); x += width(opt) + 14
x = box(x, y); spot("reason=other", *LAST_BOX[-1]); text(x, y, "Other:"); line(x + width("Other:") + 4, R, y + 2)
spot("reason_other", x + width("Other:") + 6, y - 11, R - (x + width("Other:") + 6), 13)

y += 34
text(L, y, "Details of termination:")
first = y + 22
for _ in range(5):
    y += 22; line(L, R, y + 2)
# fill.ts puts wrapped line i's baseline at box.y + (i+1)*line_height - size/4;
# this puts each one 2.5pt above its rule.
spot("details", L, first - 22.5 + 11 * 0.25, R - L, 5 * 22, multiline=True, line_height=22, font_size=11)

y += 38
def yes_no(y, q, tail=None):
    text(L, y, q)
    x = 352
    x = box(x, y); text(x, y, "Yes"); x += width("Yes") + 18
    yes_box = LAST_BOX[-1]
    x = box(x, y); text(x, y, "No")
    if tail: text(x + width("No") + 14, y, tail, "tiit", 10.5)
    return yes_box, LAST_BOX[-1]
for key, q, tail in [("eligible_rehire", "Is this employee eligible for rehire?", None), ("medical_plan", "Was this employee on a medical plan?", None), ("has_property", "Does the employee possess company property?", "If yes, detail below")]:
    yb, nb = yes_no(y, q, tail)
    spot(key + "=yes", *yb); spot(key + "=no", *nb)
    y += 24
y -= 24
first = y + 24
for _ in range(2):
    y += 24; line(L, R, y + 2)
spot("property_detail", L, first - 24.5 + 11 * 0.25, R - L, 2 * 24, multiline=True, line_height=24, font_size=11)

# ---- signatures ----
y += 58
for (x0, x1, d0, d1, lab, k) in [(L, 222, 232, 296, "Manager Signature", "manager"), (318, 468, 478, R, "Employee Signature", "employee")]:
    spot(k + "_signature", x0 + 14, y - 34, x1 - x0 - 16, 34)
    spot(k + "_date", d0 + 1, y - 11, d1 - d0 - 1, 13, font_size=10)
    text(x0, y, "X", "tibo", 13)
    line(x0 + 12, x1, y + 2)
    line(d0, d1, y + 2)
    text(x0 + 12, y + 15, lab, "tiro", 10)
    text(d0, y + 15, "Date", "tiro", 10)

import json
json.dump(SPOTS, open("report_spots.json", "w"), indent=1)
doc.subset_fonts()
doc.set_metadata({"title": "Employee Termination Report", "author": "Splash Car Wash"})
doc.save(OUT, garbage=4, deflate=True)
print("y end", y)
