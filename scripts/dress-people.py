#!/usr/bin/env python3
"""Paint clothes and hair onto the people (runtime/characters/<name>/body.glb) as vertex colours, by where each vertex is on the
body at rest (T-pose). The cloth is the body's own surface, so it moves exactly with the skin: no tubes to misalign.
    ~/.cache/raea-anny-venv/bin/python scripts/dress-people.py   # all three
Run after scripts/make-people.sh (which writes plain bodies). Idempotent: it reads the undressed body from runtime/characters/<name>/undressed.glb if present.
"""
import json, os, shutil, struct, sys
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def hexc(h): return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255.0
def srgb2lin(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

OUTFIT = {
    # skin, hair, coat, vest, trousers, boots, collar, dress(bool)
    "man":   dict(skin="#d7b08f", hair="#4a3626", coat="#6a5340", vest="#b09a70", trou="#4d4a48", boot="#2a211b", collar="#ece6d8", dress=False),
    "woman": dict(skin="#e3bd9f", hair="#3b2a22", coat="#7a5590", vest="#9a7aae", trou="#7a5590", boot="#2a211b", collar="#ece6d8", dress=True),
    "kid":   dict(skin="#ecc7a2", hair="#d6b45c", coat="#b78fd0", vest="#d8c0e8", trou="#c9a97d", boot="#9a7a52", collar="#b78fd0", dress=False),
}

def read_glb(path):
    b = open(path, "rb").read()
    jl, = struct.unpack_from("<I", b, 12)
    js = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl, = struct.unpack_from("<I", b, off)
    return js, bytearray(b[off + 8: off + 8 + bl])

def write_glb(path, js, blob):
    while len(blob) % 4: blob.append(0)
    js["buffers"] = [{"byteLength": len(blob)}]
    j = json.dumps(js, separators=(",", ":")).encode()
    j += b" " * (-len(j) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(blob))
    out += struct.pack("<II", len(j), 0x4E4F534A) + j + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    open(path, "wb").write(out)

def dress(name):
    d = os.path.join(HERE, "runtime", "characters", name)
    src = os.path.join(d, "undressed.glb")
    if not os.path.exists(src): shutil.copy(os.path.join(d, "body.glb"), src)
    js, blob = read_glb(src)
    sk = json.load(open(os.path.join(d, "skeleton.json")))
    P = js["meshes"][0]["primitives"][0]
    acc = js["accessors"][P["attributes"]["POSITION"]]
    bv = js["bufferViews"][acc["bufferView"]]
    n = acc["count"]
    pos = np.frombuffer(bytes(blob[bv.get("byteOffset", 0) + acc.get("byteOffset", 0):][:n * 12]), np.float32).reshape(n, 3).copy()
    # the mesh is in Anny's own rest frame: the skeleton's joint heads there are bind.heads
    J = {j["name"]: np.array(sk["bind"]["heads"][i]) for i, j in enumerate(sk["joints"])}
    o = OUTFIT[name]
    # the body at rest is in the T-pose (arms out along x), y up, facing +z
    neck_y, hips_y = J["Neck"][1], J["Hips"][1]
    knee_y, ankle_y = J["LeftLeg"][1], J["LeftFoot"][1]
    wrist_x = abs(J["LeftHand"][0])
    sh_x = abs(J["LeftArm"][0])
    eyes = np.array(sk["landmarks"]["eyes"])  # (already in the mesh frame)
    # indices first: every triangle is judged by its own middle, so a boundary is a clean line across the mesh, not a ragged edge of corners
    ia = js["accessors"][P["indices"]]
    ibv = js["bufferViews"][ia["bufferView"]]
    dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}[ia["componentType"]]
    base = ibv.get("byteOffset", 0) + ia.get("byteOffset", 0)
    idx = np.frombuffer(bytes(blob[base:base + ia["count"] * np.dtype(dt).itemsize]), dt).reshape(-1, 3).astype(np.uint32)
    cen = pos[idx].mean(axis=1)
    x, y, z = cen[:, 0], cen[:, 1], cen[:, 2]
    ax = np.abs(x)
    m = len(idx)
    reg = np.zeros(m, np.int32)  # 0 skin, 1 hair, 2 coat, 3 vest, 4 trousers, 5 boots, 6 collar
    arm = (y > hips_y + 0.25) & (ax > sh_x - 0.02)  # arms hang out from the shoulders
    torso = (y > hips_y - 0.02) & (y < neck_y + 0.0) & ~arm
    legs = (y < hips_y + 0.02) & ~arm
    hem = (knee_y - 0.18) if o["dress"] else ankle_y + 0.07
    reg[legs & (y > hem)] = 4
    reg[legs & (y <= ankle_y + 0.075)] = 5
    reg[torso] = 2
    if not o["dress"]:
        reg[legs & (y > hips_y - 0.22)] = 2
    else:
        reg[legs & (y > hem)] = 2
    reg[arm & (ax < wrist_x - 0.035)] = 2
    reg[torso & (z > 0.045) & (ax < 0.07) & (y > hips_y + 0.05)] = 3
    reg[(y > neck_y - 0.035) & (y < neck_y + 0.02) & (np.hypot(x, z) < 0.09)] = 6
    head = (y > neck_y + 0.03)
    hair = head & ((y > eyes[1] + 0.035) | ((z < eyes[2] - 0.065) & (y > neck_y + 0.06)))
    if name == "woman": hair = hair | (head & (z < eyes[2] - 0.03) & (y > neck_y - 0.12) & (np.hypot(x, z) < 0.13))
    reg[hair] = 1
    tri = reg
    # indices: one primitive per region (a triangle goes to the region most of its corners are in), each with its own flat material
    names = ["skin", "hair", "coat", "vest", "trou", "boot", "collar"]
    old_mat = js["materials"][P.get("material", 0)]
    prims = []
    mats = []
    for k, nm in enumerate(names):
        sel = idx[tri == k]
        if not len(sel): continue
        data = sel.astype(np.uint32).tobytes()
        while len(blob) % 4: blob.append(0)
        start = len(blob)
        blob += data
        js["bufferViews"].append({"buffer": 0, "byteOffset": start, "byteLength": len(data), "target": 34963})
        js["accessors"].append({"bufferView": len(js["bufferViews"]) - 1, "componentType": 5125, "count": int(sel.size), "type": "SCALAR"})
        c = srgb2lin(hexc(o[nm if nm != "trou" else "trou"] if nm != "boot" else o["boot"]))
        mats.append({"name": nm, "pbrMetallicRoughness": {"baseColorFactor": [float(c[0]), float(c[1]), float(c[2]), 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.82}})
        q = dict(P)
        q["indices"] = len(js["accessors"]) - 1
        q["material"] = len(js["materials"]) + len(mats) - 1
        prims.append(q)
    js["materials"] = js["materials"] + mats
    js["meshes"][0]["primitives"] = prims
    write_glb(os.path.join(d, "body.glb"), js, blob)
    print(name, "dressed:", {nm: int((tri == k).sum()) for k, nm in enumerate(names)})

for nm in (sys.argv[1:] or ["man", "woman", "kid"]):
    dress(nm)
