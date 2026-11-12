"""
Generates src/styles.themed.css (the stylesheet the app loads) from src/styles.css (the one we edit).

Every fixed colour in styles.css is replaced by a variable with a light value (the original colour)
and a dark value, converted by the ROLE the colour plays there (not just inverted):
  - backgrounds  -> dark surfaces (white = the card surface; light tints = slightly lighter, tinted
                    surfaces, so the layers keep their order)
  - text         -> light text (white text on coloured fills stays white)
  - lines        -> dark, quiet borders
  - strong colours (status fills, buttons, accents) stay strong, a little brighter
The rules themselves stay where they are, with the same selectors, so the cascade is exactly the
same in both themes. Colours that come from variables (var(--...)) flip through :root in styles.css.

Run after changing colours in styles.css:   python client/scripts/make-dark.py
"""
import colorsys, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src', 'styles.css')
OUT = os.path.join(HERE, '..', 'src', 'styles.themed.css')

SURFACE = (0x16, 0x1b, 0x23)                      # = --surface in the dark theme
KEEP = ('.look-pic', '.lp-bar', 'data-theme')     # rules left exactly as they are


def clamp(v, a, b):
    return max(a, min(b, v))


def to_rgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def to_hex(rgb):
    return '#' + ''.join(f'{int(round(clamp(c, 0, 255))):02x}' for c in rgb)


def hls(rgb):
    return colorsys.rgb_to_hls(*(c / 255 for c in rgb))


def from_hls(h, l, s):
    return tuple(c * 255 for c in colorsys.hls_to_rgb(h, clamp(l, 0, 1), clamp(s, 0, 1)))


def convert(rgb, role):
    h, l, s = hls(rgb)
    L = l * 100
    vivid = s > 0.3 and 25 < L < 80
    if rgb == (255, 255, 255):
        return rgb if role == 'text' else SURFACE
    if role == 'text':
        if L < 55:                                   # dark text -> light text, keep a hint of its hue
            return from_hls(h, clamp(100 - L * 0.8, 62, 93) / 100, s * (0.75 if s > 0.25 else 0.4))
        if s < 0.25 and L < 85:                      # light grey (quiet / disabled) text -> mid grey
            return from_hls(h, clamp(108 - L, 40, 60) / 100, s * 0.5)
        return rgb
    if role == 'bg':
        if L >= 80:
            if s < 0.3 or L >= 97.5:                 # neutral light backgrounds -> layered dark greys
                return from_hls(h, clamp(12 + (100 - L) * 1.25, 12, 30) / 100, min(s, 0.18))
            return from_hls(h, clamp(15 + (100 - L) * 0.7, 15, 30) / 100, min(s, 0.55) * 0.6)  # tints
        if vivid:
            return from_hls(h, (L + 3) / 100, s)
        return from_hls(h, clamp(L + 10, 18, 45) / 100, s)   # dark neutral fills (e.g. toasts)
    # lines: borders, strokes, rings
    if L >= 70:
        if s < 0.3:
            return from_hls(h, clamp(20 + (100 - L) * 0.6, 22, 40) / 100, min(s, 0.15))
        return from_hls(h, clamp(28 + (100 - L) * 0.5, 28, 45) / 100, s * 0.5)
    if vivid:
        return from_hls(h, (L + 6) / 100, s)
    return from_hls(h, clamp(100 - L * 0.75, 35, 75) / 100, s)


def role_of(prop, rgb):
    prop = prop.strip().lower()
    if prop == 'color':
        return 'text'
    if prop.startswith('background') or prop == 'stop-color':
        return 'bg'
    if prop == 'fill':
        L = hls(rgb)[1] * 100
        if L < 50:      # dark fills are text or dark shapes (labels, milestones): they must turn light
            return 'text'
        return 'bg' if L >= 80 else 'line'
    if prop == 'box-shadow' and rgb == (255, 255, 255):
        return 'bg'
    return 'line'


HEX = re.compile(r'#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b')
RGBA = re.compile(r'rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)')

tokens = {}   # (light, dark) -> name


def token(light, dark):
    if light.lower() == dark.lower():
        return light
    k = (light.lower(), dark.lower())
    if k not in tokens:
        tokens[k] = f'--t{len(tokens) + 1}'
    return f'var({tokens[k]})'


def themed_value(prop, value):
    def hex_sub(m):
        rgb = to_rgb(m.group(0))
        return token(m.group(0), to_hex(convert(rgb, role_of(prop, rgb))))

    def rgba_sub(m):
        r, g, b, a = int(m.group(1)), int(m.group(2)), int(m.group(3)), float(m.group(4))
        if (r, g, b) in ((16, 24, 40), (0, 0, 0)) and prop.strip() != 'background':
            d = f'rgba(0, 0, 0, {min(0.6, a * 3):.2f})'            # shadows: deeper on dark
        elif (r, g, b) == (15, 23, 42):
            d = f'rgba(0, 0, 0, {min(0.75, a * 1.5 + 0.1):.2f})'    # dimming overlays
        elif (r, g, b) == (255, 255, 255):
            d = f'rgba({SURFACE[0]}, {SURFACE[1]}, {SURFACE[2]}, {a})'
        else:
            d = f'rgba({r}, {g}, {b}, {min(0.5, a * 2):.2f})'       # coloured tints: a little stronger
        return token(m.group(0), d)

    return RGBA.sub(rgba_sub, HEX.sub(hex_sub, value))


def transform_body(body):
    out = []
    for piece in re.split(r'(;)', body):
        if ':' in piece and piece != ';':
            prop, val = piece.split(':', 1)
            name = re.sub(r'/\*.*?\*/', '', prop, flags=re.S).strip()
            if not name.startswith('--') and (HEX.search(val) or RGBA.search(val)):
                piece = prop + ':' + themed_value(name, val)
        out.append(piece)
    return ''.join(out)


def transform(css):
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0:
            out.append(css[i:])
            break
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{':
                depth += 1
            elif css[k] == '}':
                depth -= 1
            k += 1
        prelude, body = css[i:j], css[j + 1:k - 1]
        clean = re.sub(r'/\*.*?\*/', '', prelude, flags=re.S).strip()
        if clean.startswith('@media') or clean.startswith('@supports'):
            body = transform(body)
        elif clean.startswith('@') or clean == ':root' or any(x in clean for x in KEEP):
            pass
        else:
            body = transform_body(body)
        out.append(prelude + '{' + body + '}')
        i = k
    return ''.join(out)


def main():
    css = open(SRC, encoding='utf8').read()
    body = transform(css)
    light = '\n'.join(f'  {name}: {l};' for (l, d), name in tokens.items())
    dark = '\n'.join(f'  {name}: {d};' for (l, d), name in tokens.items())
    open(OUT, 'w', encoding='utf8').write(
        '/* GENERATED by client/scripts/make-dark.py from styles.css: do not edit by hand, edit styles.css and run it. */\n'
        f':root {{\n{light}\n}}\n:root[data-theme="dark"] {{\n{dark}\n}}\n\n' + body)
    print(f'{len(tokens)} colour tokens -> {OUT}')


if __name__ == '__main__':
    main()
