#!/usr/bin/env python3
"""Colour variants of the Quaternius bird (CC0): the model's body material is recoloured, so a sparrow is brown and a crow is dark, not all a blue jay.
Writes runtime/creatures/bird-<name>.glb and the matching entries in src/catalog/creatures.json (same size, animation and facing as `bird`)."""
import json, struct, sys, os
root = os.path.join(os.path.dirname(__file__), "..")
src = open(os.path.join(root, "runtime/creatures/bird.glb"), "rb").read()
VARIANTS = {"brown": "#7a5a3c", "dark": "#26262d", "white": "#e9e6df", "red": "#b5442f", "yellow": "#d9b43a", "grey": "#7d8088"}
def lin(c): return ((c / 255 + 0.055) / 1.055) ** 2.4 if c / 255 > 0.04045 else c / 255 / 12.92
n = struct.unpack("<I", src[12:16])[0]
head, jbytes, rest = src[:12], src[20:20 + n], src[20 + n:]
cat = os.path.join(root, "src/catalog/creatures.json")
cj = json.load(open(cat))
for name, hexc in VARIANTS.items():
    j = json.loads(jbytes)
    r, g, b = (int(hexc[i:i + 2], 16) for i in (1, 3, 5))
    j["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] = [lin(r), lin(g), lin(b), 1.0]  # (material 0 is the body; 1 is beak and legs)
    out = json.dumps(j, separators=(",", ":")).encode()
    out += b" " * ((4 - len(out) % 4) % 4)
    total = 12 + 8 + len(out) + len(rest)
    open(os.path.join(root, f"runtime/creatures/bird-{name}.glb"), "wb").write(struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(out), b"JSON") + out + rest)
    cj[f"bird-{name}"] = {**cj["bird"], "swatch": hexc}
json.dump(cj, open(cat, "w"), indent=1)
print("ok", list(VARIANTS))
