#!/usr/bin/env python3
"""Rebuild the Loadbyton vector kit from local OFL fonts and brand.config.json.

Requires Python 3, fonttools and brotli. No network, tracing or raster embedding.
Raster/PDF exports and the ZIP are made by export-brand.mjs afterwards.
"""
from pathlib import Path
from html import escape
import json
import math
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parents[1]
B = ROOT / "public/brand"
C = json.loads((B / "brand.config.json").read_text())
P = C["palette"]
N, R, W, CREAM = P["navy"], P["red"], P["white"], P["cream"]
FONTS = {name: TTFont(B / "fonts" / (filename + ".woff2")) for name, filename in
         [("display", "geist"), ("body", "inter"), ("mono", "jetbrains-mono")]}
GLYPHS = {}
ASSETS = []


def outlined(text, x, y, size=32, color=N, weight=600, font="display", spacing=0, anchor="start"):
    """Outline exact font glyphs. Masters need no installed fonts at consumption."""
    f = FONTS[font]
    key = (font, weight)
    if key not in GLYPHS:
        GLYPHS[key] = f.getGlyphSet(location={"wght": weight})
    glyphs = GLYPHS[key]
    cmap = f.getBestCmap()
    scale = size / f["head"].unitsPerEm
    pieces, advance = [], 0.0
    for char in text:
        if ord(char) not in cmap:
            raise ValueError(f"Unmapped glyph {char!r}; use reviewed supported copy")
        g = glyphs[cmap[ord(char)]]
        pen = SVGPathPen(glyphs)
        g.draw(pen)
        d = pen.getCommands()
        if d:
            pieces.append(f'<path transform="translate({advance:.4f} 0)" d="{d}"/>')
        advance += g.width + spacing / scale
    width = (advance - spacing / scale if text else 0) * scale
    if anchor == "middle":
        x -= width / 2
    elif anchor == "end":
        x -= width
    return f'<g fill="{color}" aria-label="{escape(text, quote=True)}" transform="translate({x:.4f} {y:.4f}) scale({scale:.8f} {-scale:.8f})">' + ''.join(pieces) + '</g>'


def text(s, x, y, size=32, color=N, weight=600, font="display", anchor="start"):
    # Template text remains editable; print/render copies outline these elements.
    return f'<text x="{x}" y="{y}" font-family="{C["fonts"][font]}, sans-serif" font-size="{size}" font-weight="{weight}" fill="{color}" text-anchor="{anchor}">{escape(s)}</text>'


def rect(x, y, w, h, color, radius=0, extra=""):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{color}" {extra}/>'


def svg(title, w, h, body, physical=None):
    dims = f'width="{physical[0]}mm" height="{physical[1]}mm"' if physical else f'width="{w}" height="{h}"'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" {dims} role="img" aria-label="{escape(title, quote=True)}"><title>{escape(title)}</title>{body}</svg>\n'


def save(path, title, w, h, body, category, physical=None, editable=False):
    p = B / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(svg(title, w, h, body, physical))
    ASSETS.append({"path": path, "title": title, "category": category, "width": w, "height": h,
                   "physicalMm": physical, "editableText": editable})


def logo(color=N, accent=R, suffix=None):
    # Positions follow the reference wordmark; crop excess padding and add an OS-specific descriptor separately.
    out = outlined("LOAD", 18, 84, 58, color, 900, spacing=2)
    out += rect(216, 24, 4, 64, accent)
    out += outlined("B", 246, 61, 22, accent, 900, anchor="middle")
    out += outlined("Y", 246, 86, 22, accent, 900, anchor="middle")
    out += rect(272, 24, 4, 64, accent)
    out += outlined("TON", 294, 84, 58, color, 900, spacing=2)
    if suffix:
        out += outlined(suffix, 431, 84, 27, color, 700)
    return out


def logo_at(x, y, width, color=N, suffix=".store", accent=R):
    native = 560 if suffix else 450
    return f'<g transform="translate({x} {y}) scale({width/native})">{logo(color, accent, suffix)}</g>'


def mark(color=W, background=N, accent=R):
    return rect(0, 0, 128, 128, background, 16) + rect(21, 22, 4, 84, accent) + rect(103, 22, 4, 84, accent) + outlined("B", 64, 62, 44, color, 900, anchor="middle") + outlined("Y", 64, 106, 44, color, 900, anchor="middle")


def motif(x, y, size=1, color=R, opacity=1):
    return f'<g opacity="{opacity}" transform="translate({x} {y}) scale({size})">' + ''.join(rect(i*46, 0, 8, 220, color) for i in range(4)) + '</g>'


def lines(items, x, y, size=44, color=N, leading=1.18, weight=700):
    return ''.join(text(s, x, y+i*size*leading, size, color, weight) for i,s in enumerate(items))


def label(s, x, y, color=P["muted"], size=16):
    return text(s, x, y, size, color, 500, "mono")


# The primary masters: true paths, no <image>, no fonts, no external dependencies.
for name, color, accent in [("navy",N,R),("white",W,R),("black","#000000","#000000"),("mono-white",W,W)]:
    save(f'masters/logo-parent-{name}.svg', f'LOAD BY TON parent wordmark — {name}',450,112,logo(color,accent),"Logo masters")
    save(f'logo-{name}.svg', f'LOAD BY TON.store — {name}',560,112,logo(color,accent,".store"),"Logo masters")
    osbody = logo(color,accent) + outlined("OPERATING PLATFORM",21,123,16,color,500,spacing=3)
    save(f'masters/logo-os-{name}.svg', f'Loadbyton operating platform — {name}',450,150,osbody,"Logo masters")
save('logo-silver.svg','LOAD BY TON.store on a dark surface',560,112,logo(W,R,".store"),"Logo masters")
save('by-mark.svg','Loadbyton stacked BY icon',128,128,mark(),"App icons")
save('masters/by-mark-reverse.svg','Loadbyton BY icon on light tile',128,128,mark(N,CREAM),"App icons")
save('masters/by-mark-mono.svg','Loadbyton BY icon monochrome',128,128,mark(W,N,N),"App icons")
save('masters/by-mark-transparent.svg','Loadbyton BY mark without tile',128,128,rect(21,22,4,84,R)+rect(103,22,4,84,R)+outlined("B",64,62,44,N,900,anchor="middle")+outlined("Y",64,106,44,N,900,anchor="middle"),"Logo masters")
save('masters/by-mark-transparent-white.svg','Loadbyton BY mark on dark without tile',128,128,rect(21,22,4,84,R)+rect(103,22,4,84,R)+outlined("B",64,62,44,W,900,anchor="middle")+outlined("Y",64,106,44,W,900,anchor="middle"),"Logo masters")
save('favicon.svg','Loadbyton small-size BY favicon',32,32,rect(0,0,32,32,N,4)+rect(4,5,2,22,R)+rect(26,5,2,22,R)+outlined('B',16,16,12,W,900,anchor='middle')+outlined('Y',16,27,12,W,900,anchor='middle'),"App icons")
save('app-icon-maskable.svg','Loadbyton maskable app icon; mark inside 80% safe circle',512,512,rect(0,0,512,512,N)+f'<g transform="translate(126 126) scale(2.03125)">{mark()}</g>',"App icons")
for product in C['products']:
    for mode,color in [('navy',N),('white',W)]:
        body = logo(color,R) + outlined(product.upper(),21,134,24,color,600,spacing=3)
        save(f'products/{product.lower()}-{mode}.svg',f'LOAD BY TON {product}',450,160,body,"Product lockups")


ICON_PATHS = {
 'freight-forwarding':'<path d="M3 17h18M5 17l2 4h10l2-4M5 14V8h14v6M8 8V4h8v4M8 11v3m4-3v3m4-3v3"/>',
 'road-transport':'<path d="M3 6h11v11H3zM14 10h4l3 4v3h-7M16 10v4h5"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
 'contract-warehouse-3pl':'<path d="M3 10l9-6 9 6v11H3zM9 21v-8h6v8M6 10h12"/>',
 'courier-last-mile':'<path d="M3 8l9-4 9 4-9 4zM3 8v9l9 4 9-4V8M12 12v9M7 6l10 4"/>',
 'ecommerce-fulfilment':'<path d="M3 4h3l3 12h10l2-8H7M10 8l3 3 4-4"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
 'customs-brokerage':'<path d="M6 3h9l3 3v15H6zM14 3v5h4M9 12h6M9 16h3"/><path d="M14 17l2 2 4-4"/>',
 'consolidation-nvocc':'<path d="M3 4h8v6H3zM13 4h8v6h-8zM8 15h8v6H8zM7 10v2h10v-2M12 12v3"/>',
 'cold-chain':'<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M3 10l4-1-1-4M21 14l-4 1 1 4M3 14l4 1-1 4M21 10l-4-1 1-4"/>',
 'project-heavy-cargo':'<path d="M5 21V3h3v18M8 4h13v3H8M5 8H2M18 7v5l-2 2M2 21h10M14 17h7v4h-7z"/>',
 'automotive-logistics':'<path d="M4 10l2-5h12l2 5M3 10h18v8H3zM5 18v3M19 18v3M6 14h2M16 14h2"/>',
 'marine-agency':'<path d="M12 3v15M8 7h8M3 14c0 9 18 9 18 0M3 14l-1 3M21 14l1 3"/><circle cx="12" cy="4" r="2"/>',
 'aviation-logistics':'<path d="M12 2l2 7 8 4v2l-8-2v6l3 2H7l3-2v-6l-8 2v-2l8-4z"/>',
 'moving-relocation':'<path d="M3 11l9-8 9 8M5 9v12h14V9M8 21v-8h8v8M10 17h4"/>',
 'import-export-trading':'<path d="M3 8h16l-4-4M19 8l-4 4M21 16H5l4-4M5 16l4 4"/>',
 'distribution':'<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5H5v5M12 12h7v5"/>',
 'container-depot':'<path d="M3 4h18v7H3zM3 13h18v7H3zM7 4v7m5-7v7m5-7v7M7 13v7m5-7v7m5-7v7"/>',
 'dangerous-cargo':'<path d="M12 3L2 21h20zM12 9v5M12 17h.01"/>',
 'cross-border-transit':'<path d="M12 2v5m0 3v4m0 3v5M2 12h7l-3-3M9 12l-3 3M22 12h-7l3-3M15 12l3 3"/>',
 'finance':'<path d="M5 3h14v18H5zM8 7h8M8 11h2m4 0h2M8 15h2m4 0h2M8 18h8"/>',
 'intelligence':'<path d="M3 21h18M5 17v-5h3v5M11 17V7h3v10M17 17V3h3v14"/>',
 'documents':'<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/>',
 'security':'<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
 'support':'<path d="M4 14v-3a8 8 0 0116 0v3M4 12H2v6h4v-6M20 12h2v6h-4v-6M20 18v3h-7"/>',
 'settings':'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="white"/><circle cx="16" cy="12" r="2" fill="white"/><circle cx="10" cy="18" r="2" fill="white"/>'
}
symbols=[]
for slug,paths in ICON_PATHS.items():
    attrs=f'fill="none" stroke="{N}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
    save(f'icons/{slug}.svg',slug.replace('-',' ').title(),24,24,f'<g {attrs}>{paths}</g>',"Sector and UI icons")
    symbols.append(f'<symbol id="{slug}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{paths}</g></symbol>')
(B/'icons/sprite.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg">'+''.join(symbols)+'</svg>\n')

# Graphic language: route lines and container dividers, no implied GPS coverage.
save('patterns/dividers.svg','Loadbyton divider rhythm',1200,300,rect(0,0,1200,300,N)+motif(760,40,1,R,.8)+motif(60,40,1,W,.12),"Patterns")
save('patterns/container-grid.svg','Container grid pattern',1200,800,rect(0,0,1200,800,N)+''.join(f'<path d="M{x} 0v800" stroke="{W}" opacity=".08"/>' for x in range(0,1201,80))+''.join(f'<path d="M0 {y}h1200" stroke="{W}" opacity=".08"/>' for y in range(0,801,80))+rect(880,80,4,240,R)+rect(960,80,4,240,R),"Patterns")
route=f'<path d="M40 590H290V320H650V130h390" fill="none" stroke="{R}" stroke-width="8"/>'
route+=''.join(f'<circle cx="{x}" cy="{y}" r="15" fill="{N}" stroke="{W}" stroke-width="4"/>' for x,y in [(40,590),(290,320),(650,130),(1040,130)])
save('patterns/route.svg','Connected route graphic; illustrative only',1200,700,rect(0,0,1200,700,N)+route,"Patterns")

# Original vector illustrations and honest empty states.
for name,title,paths in [('shipment','Every movement, connected',ICON_PATHS['road-transport']),('warehouse','Stock with a source',ICON_PATHS['contract-warehouse-3pl']),('documents','Keep the record together',ICON_PATHS['documents']),('cash-control','Know what was received',ICON_PATHS['finance'])]:
    body=rect(0,0,800,600,CREAM)+rect(80,75,640,420,W,12)+motif(620,110,.8,R,.2)+f'<g transform="translate(210 135) scale(12)" fill="none" stroke="{N}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">{paths}</g>'+text(title,80,555,28,N,600)
    save(f'illustrations/{name}.svg',title,800,600,body,"Illustrations",editable=True)
for name,title,hint,icon in [('empty-jobs','Start with an enquiry','Your workspace starts empty.','freight-forwarding'),('empty-documents','Keep the source close','Add the first verified source document.','documents'),('restricted','Access needs a role','Ask your workspace owner to review access.','security'),('maintenance','A controlled pause','Check the published service status.','settings')]:
    body=rect(0,0,640,400,CREAM)+f'<g transform="translate(272 65) scale(4)" fill="none" stroke="{N}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{ICON_PATHS[icon]}</g>'+text(title,320,244,28,N,600,anchor='middle')+text(hint,320,282,16,P['muted'],400,'body',anchor='middle')
    save(f'illustrations/{name}.svg',title,640,400,body,"Empty states",editable=True)

def campaign(w,h,headline,subline,eyebrow='LOADBYTON OS',square=False):
    pad=round(w*.075)
    body=rect(0,0,w,h,N)+logo_at(pad,pad,w*.38,W)+motif(w*.79,h*.13,min(w/1200,h*.18/220),R,.7)
    baseline=h*.40
    size=round(min(w*.071,h*.135))
    body+=label(eyebrow,pad,baseline-55,W,max(15,round(w*.017)))
    body+=lines(headline,pad,baseline+size*.65,size,W,1.12,700)
    body+=text(subline,pad,h*.81,max(18,round(w*.022)),W,400,'body')
    body+=rect(pad,h*.88,w*.26,5,R)+label('loadbyton.store',pad,h*.95,W,max(14,round(w*.015)))
    return body

templates=[
 ('social-square',1080,1080,['Run the movement.','Know the margin.'],'Your logistics company, connected.'),
 ('social-portrait',1080,1350,['One workspace.','Every operation.'],'Build around the work your company needs.'),
 ('social-story',1080,1920,['Your logistics','company,','connected.'],'Start with the workflow you need.'),
 ('open-graph',1200,630,['Run the movement.','Know the margin.'],'LOAD|BY|TON.store'),
 ('linkedin-post',1200,627,['Keep the record','with the movement.'],'Enquiry. Job. Document. Collection.'),
 ('linkedin-cover',1584,396,['Your logistics company, connected.'],'LOADBYTON OS'),
 ('company-cover',1128,191,['Run the movement. Know the margin.'],'LOADBYTON OS'),
 ('x-cover',1500,500,['One workspace. Every operation.'],'Your logistics company, connected.'),
 ('email-header',1200,320,['Keep the work connected.'],'LOAD|BY|TON.store'),
 ('presentation-cover',1920,1080,['Your logistics company,','connected.'],'[Presentation title] / [Date]'),
 ('web-hero',1920,960,['Run the movement.','Know the margin.'],'One workspace for logistics operations.'),
 ('launch-announcement',1080,1080,['Meet your next','working context.'],'Pilot workflows. Ask about availability.'),
]
for slug,w,h,headline,subline in templates:
    if h<510:
        # Wide banners have different safe-area typography; never squeeze a social square.
        pad=round(w*.04)
        body=rect(0,0,w,h,N)+logo_at(pad,20,w*.24,W)+lines(headline,pad,h*.65,round(min(w*.034,h*.16)),W)+label(subline,pad,h*.87,W,round(max(13,h*.055)))+motif(w*.87,h*.2,h/300,R,.75)
    else:
        body=campaign(w,h,headline,subline)
    save(f'templates/{slug}.svg',slug.replace('-',' ').title(),w,h,body,"Digital templates",editable=True)

# YouTube safe area (1546 x 423 centred on a 2560 x 1440 artboard).
yb=rect(0,0,2560,1440,N)+motif(1960,440,2.2,R,.2)+logo_at(610,545,670,W)+text('Run the movement. Know the margin.',610,807,42,W,600)+label('LOADBYTON OS',610,866,W,20)
save('templates/youtube-cover.svg','YouTube cover; content within centred safe area',2560,1440,yb,"Digital templates",editable=True)

# Business/print templates. Physical artboards include 3 mm bleed where appropriate.
card_front=rect(0,0,910,610,N)+logo_at(80,83,690,W)+text(C['contact']['name'],80,343,48,W,700)+text(C['contact']['role'],80,395,28,W,400,'body')+label(C['contact']['email'],80,483,W,22)+label(C['contact']['phone'],80,522,W,22)+motif(773,345,.55,R)
card_back=rect(0,0,910,610,CREAM)+f'<g transform="translate(375 115) scale(1.25)">{mark()}</g>'+lines(['Run the movement.','Know the margin.'],455,357,38,N,1.2,700)+label('loadbyton.store',455,487,P['muted'],23)
# Back text is centred for a balanced reverse side.
card_back=rect(0,0,910,610,CREAM)+f'<g transform="translate(375 90) scale(1.25)">{mark()}</g>'+text('Run the movement.',455,340,38,N,700,anchor='middle')+text('Know the margin.',455,390,38,N,700,anchor='middle')+label('loadbyton.store',338,490,P['muted'],23)
save('templates/business-card-front.svg','Business card front; 85 x 55 mm trim + 3 mm bleed',910,610,card_front,"Print templates",(91,61),True)
save('templates/business-card-back.svg','Business card back; 85 x 55 mm trim + 3 mm bleed',910,610,card_back,"Print templates",(91,61),True)

def a4_header(title):
    return rect(0,0,2160,3030,W)+logo_at(180,155,720)+label(title,180,470,N,25)+rect(180,515,1800,5,R)
footer=rect(180,2765,1800,2,P['line'])+label(C['contact']['legalEntity'],180,2820,P['muted'],22)+label(C['contact']['address'],180,2870,P['muted'],22)+label('loadbyton.store / [Verified email]',180,2920,P['muted'],22)
lh=a4_header('[DOCUMENT TITLE]')+text('[Recipient name]',180,730,36,N,600)+text('[Recipient company / address]',180,790,28,P['muted'],400,'body')+label('[Date] / [Reference]',180,900,P['muted'],25)+lines(['[Opening paragraph]','[Replace this text with the approved correspondence.]'],180,1140,30,N,1.8,400)+text('[Your name / role]',180,2050,30,N,500)+footer
save('templates/letterhead-a4.svg','A4 letterhead; 210 x 297 mm trim + 3 mm bleed',2160,3030,lh,"Print templates",(216,303),True)
one=a4_header('OPERATING PLATFORM / PILOT WORKFLOWS')+lines(['Your logistics company,','connected.'],180,790,104,N,1.1,700)+text('Run the movement. Know the margin.',180,1100,40,P['muted'],500)
for i,(title,desc) in enumerate([('Freight','Enquiries, quotes, jobs and source documents.'),('Transport','Dispatch, trips, POD and expense evidence.'),('Warehouse / fulfilment','Custody stock and merchant fulfilment workflows.'),('Delivery / Customs','Cash controls and evidence-based handover.')]):
    yy=1420+i*260
    one+=label(f'0{i+1}',180,yy,R,28)+text(title,310,yy,42,N,600)+text(desc,310,yy+65,26,P['muted'],400,'body')
one+=text('Pilot availability and scope require confirmation.',180,2580,26,P['muted'],400,'body')+footer
save('templates/sales-one-pager-a4.svg','Sales one-pager; scoped pilot claims',2160,3030,one,"Print templates",(216,303),True)

proposal=a4_header('PROPOSAL / [CUSTOMER NAME]')+lines(['A workspace around','your operations.'],180,920,110,N,1.1,700)+label('[Prepared by] / [Date] / [Version]',180,1400,P['muted'],27)+motif(1640,1620,2.5,R,.4)+text('[Agreed scope and acceptance criteria]',180,2260,32,N,500)+footer
save('templates/proposal-cover-a4.svg','Editable proposal cover',2160,3030,proposal,"Print templates",(216,303),True)
for slug,title in [('invoice-layout','INVOICE LAYOUT / DRAFT TEMPLATE'),('packing-list-layout','PACKING LIST / DRAFT TEMPLATE'),('pod-layout','PROOF OF DELIVERY / BLANK TEMPLATE')]:
    body=a4_header(title)+text('[Customer / consignee]',180,740,40,N,600)+label('[Source reference] / [Date]',180,830,P['muted'],26)
    body+=rect(180,1010,1800,90,P['paper'])+text('[Description / item]',210,1070,28,N,600)+text('[Quantity]',1410,1070,28,N,600)+text('[Amount / reference]',1650,1070,24,N,600)
    for i in range(5): body+=rect(180,1170+i*190,1800,2,P['line'])+text('[Verified source line]',210,1230+i*190,28,P['muted'],400,'body')
    body+=text('Visual template only. Complete and review the source record.',180,2310,25,P['muted'],400,'body')+text('No tax, clearance, payment or delivery status is certified by this layout.',180,2360,24,P['muted'],400,'body')+footer
    save(f'templates/{slug}.svg',title.title(),2160,3030,body,"Document templates",(216,303),True)
env=rect(0,0,2260,1160,W)+logo_at(160,160,680)+label('[Registered return address]',160,405,P['muted'],26)+text('[Recipient name]',1210,620,44,N,600)+text('[Recipient address]',1210,700,30,N,400,'body')+rect(160,940,1940,5,R)
save('templates/envelope-dl.svg','DL envelope; 220 x 110 mm + 3 mm bleed',2260,1160,env,"Print templates",(226,116),True)
idbody=rect(0,0,600,960,N)+logo_at(52,88,496,W)+rect(180,340,240,240,P['paper'],10)+text('[Portrait]',300,473,25,N,500,anchor='middle')+text('[Team member]',300,695,34,W,600,anchor='middle')+text('[Role]',300,757,24,W,400,'body',anchor='middle')+label('[Internal identifier]',123,850,W,18)
save('templates/staff-badge.svg','Internal staff badge; not government identity',600,960,idbody,"Print templates",(60,96),True)

# Presentation content and closing frames, templates rather than fabricated evidence.
slide=rect(0,0,1920,1080,CREAM)+logo_at(100,60,390)+label('02 / WORKFLOW',100,270,P['muted'],24)+text('[Slide title]',100,398,86,N,700)+lines(['[First point with verified evidence]','[Second point and its source]','[Next step and named owner]'],110,580,38,N,1.75,400)+rect(100,980,1720,3,R)+label('[Presentation title] / [Date]',100,1030,P['muted'],20)
save('templates/presentation-content.svg','Presentation content frame',1920,1080,slide,"Digital templates",editable=True)
save('templates/presentation-closing.svg','Presentation closing frame',1920,1080,campaign(1920,1080,['Keep the work','connected.'],'[Verified contact] / [Next step]'),"Digital templates",editable=True)

# Accessible local-font CSS and design tokens; OS compatibility aliases are scoped to :root.
font_css=''
for name,file in [('Geist','geist'),('Inter','inter'),('JetBrains Mono','jetbrains-mono')]:
    font_css+=f'@font-face{{font-family:"{name}";src:url("./fonts/{file}.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}}\n'
font_css+='@font-face{font-family:"Noto Sans Arabic";src:url("./fonts/noto-sans-arabic.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap;unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF}\n'
font_css+='@font-face{font-family:"Noto Sans Arabic";src:url("./fonts/noto-sans-arabic-latin.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap;unicode-range:U+0000-00FF}\n'
tokens={"version":C['version'],"sourceCommit":C['source']['commit'],"primitive":{"color":P,"font":C['fonts'],"space":[4,8,12,16,24,32,48,64,80,96],"radius":{"small":4,"medium":6,"large":8}},"semantic":{"light":{"surface":CREAM,"text":P['ink'],"textSecondary":P['muted'],"action":N,"actionText":W,"accentAction":P['redAccessible'],"link":P['blue'],"success":P['green'],"warning":P['amber'],"danger":P['redAccessible']},"dark":{"surface":P['deep'],"raised":N,"text":"#F8FAFC","textSecondary":"#CBD5E1","action":"#F8FAFC","actionText":N,"accentAction":P['redAccessible'],"link":"#93C5FD","success":"#86EFAC","warning":"#FCD34D","danger":"#FF8B93"}},"typeScalePx":[12,14,16,18,20,24,30,38,48,60],"component":{"button":{"radius":6,"minHeight":44,"paddingInline":20},"input":{"radius":6,"minHeight":44},"card":{"radius":8},"logo":{"clearSpaceUnits":18,"fullMinWidthPx":156,"iconMinWidthPx":16}}}
(B/'design-tokens.json').write_text(json.dumps(tokens,indent=2)+'\n')
css=font_css+':root{'+''.join(f'--lbt-{k}:{v};' for k,v in P.items())+'--lbt-font-display:"Geist",system-ui,sans-serif;--lbt-font-body:"Inter",system-ui,sans-serif;--lbt-font-mono:"JetBrains Mono",monospace;--navy:var(--lbt-navy);--navy2:#1A3A52;--red:var(--lbt-redAccessible);--paper:var(--lbt-cream);--ink:var(--lbt-ink);--mute:var(--lbt-muted);--line:var(--lbt-line);--ok:var(--lbt-green);--warn:var(--lbt-amber);--radius:6px;}\n'
css+='body{font-family:var(--lbt-font-body)}h1,h2,h3,h4{font-family:var(--lbt-font-display)}.num,.nowrap{font-variant-numeric:tabular-nums}html[lang="ar"] body,html[lang="ar"] h1,html[lang="ar"] h2,html[lang="ar"] h3{font-family:"Noto Sans Arabic",var(--lbt-font-body)}\n'
(B/'design-tokens.css').write_text(css)
(B/'site.webmanifest').write_text(json.dumps({"name":C['commerceName'],"short_name":"Loadbyton","id":"/","start_url":"/","scope":"/","display":"standalone","background_color":CREAM,"theme_color":N,"icons":[{"src":"/brand/app-icon-192.png","sizes":"192x192","type":"image/png","purpose":"any"},{"src":"/brand/app-icon-512.png","sizes":"512x512","type":"image/png","purpose":"any"},{"src":"/brand/app-icon-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]},indent=2)+'\n')
(B/'asset-index.json').write_text(json.dumps({"version":C['version'],"approval":C['approval']['status'],"assets":ASSETS},indent=2)+'\n')

# Portable SVG print copies: preserve editable masters, outline only a second copy.
import xml.etree.ElementTree as ET
ET.register_namespace('', 'http://www.w3.org/2000/svg')
for asset in ASSETS:
    if not asset['editableText']:
        continue
    original=ET.fromstring((B/asset['path']).read_text())
    for parent in original.iter():
        for i,node in list(enumerate(list(parent))):
            if node.tag.rsplit('}',1)[-1]!='text':
                continue
            fam=node.get('font-family','Geist').split(',')[0]
            font={'Geist':'display','Inter':'body','JetBrains Mono':'mono'}.get(fam,'display')
            group=outlined(''.join(node.itertext()),float(node.get('x','0')),float(node.get('y','0')),float(node.get('font-size','32')),node.get('fill',N),int(node.get('font-weight','600')),font,anchor=node.get('text-anchor','start'))
            parent.remove(node); parent.insert(i,ET.fromstring('<svg xmlns="http://www.w3.org/2000/svg">'+group+'</svg>')[0])
    dest=B/'outlined'/asset['path']
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(ET.tostring(original,encoding='unicode')+'\n')

# A composed contact sheet, an exact-system overview rather than a generated logo approximation.
board=rect(0,0,1800,1440,P['deep'])
panel_w,panel_h=540,392
titles=['01 / IDENTITY','02 / CONSTRUCTION','03 / APPLICATION','04 / PROMISE','05 / PALETTE','06 / TYPOGRAPHY','07 / STATIONERY','08 / GRAPHIC LANGUAGE','09 / PRODUCT FAMILY']
for idx,title in enumerate(titles):
    col,row=idx%3,idx//3; x,y=60+col*570,60+row*440
    dark=idx in [0,3,7]
    bg=N if dark else CREAM; ink=W if dark else N
    content=rect(x,y,panel_w,panel_h,bg,6)+label(title,x+28,y+36,ink,13)
    if idx==0: content+=logo_at(x+34,y+128,472,W)+label('LOADBYTON OS / 1.0',x+34,y+312,W,14)
    elif idx==1:
        content+=f'<g transform="translate({x+207} {y+95})">{mark(N,CREAM)}</g>'+rect(x+190,y+80,162,160,'none',0,f'stroke="{P["line"]}"')+text('Two dividers. One context.',x+34,y+310,25,N,600)
    elif idx==2:
        content+=rect(x+28,y+80,484,264,W,8)+rect(x+28,y+80,484,36,N,8)+text('WORKSPACE / PILOT',x+45,y+103,11,W,500,'mono')+text('Keep the source close.',x+48,y+177,24,N,700)+rect(x+48,y+206,225,60,P['paper'],6)+text('Job record',x+62,y+243,16,N,500)+rect(x+48,y+284,150,33,P['redAccessible'],6)+text('View source',x+65,y+306,13,W,600,'body')
    elif idx==3: content+=lines(['Run the movement.','Know the margin.'],x+34,y+174,42,W,1.18,700)+rect(x+34,y+310,122,4,R)
    elif idx==4:
        for i,(name,color) in enumerate([('Navy',N),('Red',R),('Warm white',CREAM)]):
            content+=rect(x+34+i*162,y+110,144,138,color,4,f'stroke="{P["line"]}"')+text(name,x+34+i*162,y+285,18,N,600)+label(color,x+34+i*162,y+319,P['muted'],13)
    elif idx==5: content+=text('Geist',x+34,y+151,64,N,700)+text('Inter / readable operations',x+34,y+213,22,N,400,'body')+text('LBT-2026-001',x+34,y+285,24,N,500,'mono')+label('48 / 32 / 24 / 16',x+34,y+330,P['muted'],14)
    elif idx==6: content+=rect(x+28,y+99,292,176,N,4)+logo_at(x+49,y+112,244,W)+text('[Your name]',x+49,y+219,23,W,600)+rect(x+350,y+87,154,247,W,3)+logo_at(x+365,y+104,120)+rect(x+365,y+143,123,2,R)+''.join(rect(x+365,y+180+i*20,110,2,P['line']) for i in range(6))
    elif idx==7: content+=motif(x+270,y+98,1.05,R,.8)+f'<path d="M{x+32} {y+310}h120v-86h82v-106h76" fill="none" stroke="{W}" stroke-width="4"/>'+text('A record follows the movement.',x+34,y+355,20,W,500)
    elif idx==8:
        for i,name in enumerate(['FREIGHT','TRANSPORT','WAREHOUSE','DELIVERY']):
            content+=rect(x+34,y+92+i*63,4,40,R)+text(name,x+53,y+119+i*63,21,N,600)
    board+=content
save('brand-overview.svg','Loadbyton OS identity overview; review candidate',1800,1440,board,'Brand guide',editable=True)
# The overview has editable type; make its font-free variant as well.
r=ET.fromstring((B/'brand-overview.svg').read_text())
for parent in r.iter():
    for i,node in list(enumerate(list(parent))):
        if node.tag.rsplit('}',1)[-1]=='text':
            fam=node.get('font-family','Geist').split(',')[0]; font={'Geist':'display','Inter':'body','JetBrains Mono':'mono'}.get(fam,'display')
            group=outlined(''.join(node.itertext()),float(node.get('x','0')),float(node.get('y','0')),float(node.get('font-size','32')),node.get('fill',N),int(node.get('font-weight','600')),font,anchor=node.get('text-anchor','start'))
            parent.remove(node);parent.insert(i,ET.fromstring('<svg xmlns="http://www.w3.org/2000/svg">'+group+'</svg>')[0])
(B/'outlined/brand-overview.svg').write_text(ET.tostring(r,encoding='unicode')+'\n')
(B/'asset-index.json').write_text(json.dumps({"version":C['version'],"approval":C['approval']['status'],"assets":ASSETS},indent=2)+'\n')
print(f'Built {len(ASSETS)} SVG assets and portable outlined template copies.')
