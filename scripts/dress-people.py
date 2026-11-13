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

def accessor_data(js, blob, i, dt, comps):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    return np.frombuffer(bytes(blob[off:off + a["count"] * comps * np.dtype(dt).itemsize]), dt).reshape(a["count"], comps).copy()

def add_accessor(js, blob, arr, ctype, typ, target):
    while len(blob) % 4: blob.append(0)
    start = len(blob)
    data = arr.tobytes()
    blob += data
    js["bufferViews"].append({"buffer": 0, "byteOffset": start, "byteLength": len(data), "target": target})
    acc = {"bufferView": len(js["bufferViews"]) - 1, "componentType": ctype, "count": int(len(arr)), "type": typ}
    if typ == "VEC3" and ctype == 5126:
        acc["min"] = [float(v) for v in arr.min(axis=0)]
        acc["max"] = [float(v) for v in arr.max(axis=0)]
    js["accessors"].append(acc)
    return len(js["accessors"]) - 1

def refine(pos, nrm, uv, jt, wt, idx, labels_of, passes=3):
    """Split the triangles that straddle a boundary between two regions (and their neighbours, so there are no cracks) so the
    boundary can run in a straight line between small triangles instead of a saw-tooth between big ones. Skin weights of a new
    vertex are its edge's two ends averaged (the four strongest kept)."""
    pos, nrm, uv, jt, wt, idx = [a.copy() for a in (pos, nrm, uv, jt, wt, idx)]
    for _ in range(passes):
        lab = labels_of(pos)
        L = lab[idx]
        strad = (L[:, 0] != L[:, 1]) | (L[:, 1] != L[:, 2])
        if not strad.any(): break
        marked = {}
        npos, nnrm, nuv, njt, nwt = [], [], [], [], []
        base = len(pos)
        def mid(a, b):
            k = (a, b) if a < b else (b, a)
            if k in marked: return marked[k]
            vid = base + len(npos)
            npos.append((pos[a] + pos[b]) / 2)
            n = nrm[a] + nrm[b]; nnrm.append(n / (np.linalg.norm(n) + 1e-9))
            nuv.append((uv[a] + uv[b]) / 2)
            w = {}
            for v in (a, b):
                for j in range(4):
                    if wt[v, j] > 0: w[int(jt[v, j])] = w.get(int(jt[v, j]), 0) + float(wt[v, j]) * 0.5
            top = sorted(w.items(), key=lambda kv: -kv[1])[:4]
            tot = sum(x for _, x in top) or 1.0
            top += [(0, 0.0)] * (4 - len(top))
            njt.append([j for j, _ in top]); nwt.append([x / tot for _, x in top])
            marked[k] = vid
            return vid
        for t in np.nonzero(strad)[0]:
            for e in range(3):
                mid(int(idx[t, e]), int(idx[t, (e + 1) % 3]))
        out = []
        for t in range(len(idx)):
            v = [int(idx[t, 0]), int(idx[t, 1]), int(idx[t, 2])]
            m = [marked.get((min(v[e], v[(e + 1) % 3]), max(v[e], v[(e + 1) % 3]))) for e in range(3)]
            n = sum(x is not None for x in m)
            if n == 0: out.append(v)
            elif n == 1:
                i = [e for e in range(3) if m[e] is not None][0]
                a, b, c = v[i], v[(i + 1) % 3], v[(i + 2) % 3]; mm = m[i]
                out += [[a, mm, c], [mm, b, c]]
            elif n == 2:
                j = [e for e in range(3) if m[e] is None][0]
                v0, v1, v2 = v[(j + 1) % 3], v[(j + 2) % 3], v[j]
                m01, m12 = m[(j + 1) % 3], m[(j + 2) % 3]
                out += [[m01, v1, m12], [v0, m01, m12], [v0, m12, v2]]
            else:
                out += [[v[0], m[0], m[2]], [m[0], v[1], m[1]], [m[2], m[1], v[2]], [m[0], m[1], m[2]]]
        pos = np.concatenate([pos, np.array(npos, np.float32)]); nrm = np.concatenate([nrm, np.array(nnrm, np.float32)])
        uv = np.concatenate([uv, np.array(nuv, np.float32)]); jt = np.concatenate([jt, np.array(njt, jt.dtype)]); wt = np.concatenate([wt, np.array(nwt, np.float32)])
        idx = np.array(out, np.uint32)
    return pos, nrm, uv, jt, wt, idx

def compact(js, blob):
    """Drop the buffers nothing refers to any more (the body's first geometry, now replaced by the refined one)."""
    used = set()
    for me in js["meshes"]:
        for pr in me["primitives"]:
            used.update(pr["attributes"].values())
            if "indices" in pr: used.add(pr["indices"])
    for sk in js.get("skins", []):
        if "inverseBindMatrices" in sk: used.add(sk["inverseBindMatrices"])
    for an in js.get("animations", []):
        for sm in an["samplers"]: used.update([sm["input"], sm["output"]])
    amap = {}
    nacc, nbv, out = [], [], bytearray()
    for i in sorted(used):
        a = dict(js["accessors"][i])
        bv = js["bufferViews"][a["bufferView"]]
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        size = bv["byteLength"] - a.get("byteOffset", 0) if "byteStride" in bv else None
        isz = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]] * {5121: 1, 5123: 2, 5125: 4, 5126: 4}[a["componentType"]]
        data = bytes(blob[off:off + a["count"] * isz])
        while len(out) % 4: out.append(0)
        nbv.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data), **({"target": bv["target"]} if "target" in bv else {})})
        out += data
        a["bufferView"] = len(nbv) - 1
        a.pop("byteOffset", None)
        amap[i] = len(nacc)
        nacc.append(a)
    for me in js["meshes"]:
        for pr in me["primitives"]:
            pr["attributes"] = {k: amap[v] for k, v in pr["attributes"].items()}
            if "indices" in pr: pr["indices"] = amap[pr["indices"]]
    for sk in js.get("skins", []):
        if "inverseBindMatrices" in sk: sk["inverseBindMatrices"] = amap[sk["inverseBindMatrices"]]
    for an in js.get("animations", []):
        for sm in an["samplers"]: sm["input"], sm["output"] = amap[sm["input"]], amap[sm["output"]]
    for im in js.get("images", []):  # embedded pictures live in buffer views too
        if "bufferView" in im:
            bv = js["bufferViews"][im["bufferView"]]
            data = bytes(blob[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]])
            while len(out) % 4: out.append(0)
            nbv.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data)})
            out += data
            im["bufferView"] = len(nbv) - 1
    js["accessors"], js["bufferViews"] = nacc, nbv
    return out

def dress(name):
    d = os.path.join(HERE, "runtime", "characters", name)
    src = os.path.join(d, "undressed.glb")
    if not os.path.exists(src): shutil.copy(os.path.join(d, "body.glb"), src)
    js, blob = read_glb(src)
    sk = json.load(open(os.path.join(d, "skeleton.json")))
    P = js["meshes"][0]["primitives"][0]
    A = P["attributes"]
    pos = accessor_data(js, blob, A["POSITION"], np.float32, 3)
    nrm = accessor_data(js, blob, A["NORMAL"], np.float32, 3)
    uv = accessor_data(js, blob, A["TEXCOORD_0"], np.float32, 2)
    jt = accessor_data(js, blob, A["JOINTS_0"], np.uint16, 4)
    wt = accessor_data(js, blob, A["WEIGHTS_0"], np.float32, 4)
    idx = accessor_data(js, blob, P["indices"], {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}[js["accessors"][P["indices"]]["componentType"]], 1).reshape(-1, 3).astype(np.uint32)
    # the mesh is in Anny's own rest frame: the skeleton's joint heads there are bind.heads
    J = {j["name"]: np.array(sk["bind"]["heads"][i]) for i, j in enumerate(sk["joints"])}
    o = OUTFIT[name]
    # the body at rest is in the T-pose (arms out along x), y up, facing +z
    neck_y, hips_y = J["Neck"][1], J["Hips"][1]
    knee_y, ankle_y = J["LeftLeg"][1], J["LeftFoot"][1]
    wrist_x = abs(J["LeftHand"][0])
    sh_x = abs(J["LeftArm"][0])
    eyes = np.array(sk["landmarks"]["eyes"])  # (already in the mesh frame)

    def classify(pts):
        x, y, z = pts[:, 0], pts[:, 1], pts[:, 2]
        ax = np.abs(x)
        reg = np.zeros(len(pts), np.int32)  # 0 skin, 1 hair, 2 coat, 3 vest, 4 trousers, 5 boots, 6 collar, 7 beard
        arm = (ax > sh_x + 0.05 * (hips_y / 1.12)) & (y > hips_y - 0.3 * (hips_y / 1.12))  # the arms: out beyond the shoulder line (the bind pose holds them angled down), from the shoulder to the hand
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
        reg[(y > neck_y - 0.035) & (y < neck_y + 0.02) & (np.hypot(x, z) < 0.09)] = 6
        head = (y > neck_y + 0.03)
        arch = 0.022 * np.clip(1 - (ax / 0.10) ** 2, 0, 1)  # a hairline is higher in the middle of the forehead than at the temples
        hair = head & ((y > eyes[1] + 0.035 + arch) | ((z < eyes[2] - 0.065) & (y > neck_y + 0.06)))
        if name == "woman": hair = hair | (head & (z < eyes[2] - 0.03) & (y > neck_y - 0.12) & (np.hypot(x, z) < 0.13))
        if name == "man":
            # a man's hair is cropped: a higher hairline and the back and sides cut at the ear, not a bob down to the neck
            hair = head & ((y > eyes[1] + 0.05 + arch) | ((z < eyes[2] - 0.085) & (y > eyes[1] - 0.005)))
        reg[hair] = 1
        if name == "man":
            # a beard region (jaw, chin, upper lip), painted in the skin's colour unless the character has one (scene.tsx: look.beard)
            # one continuous beard: from under the nose down over the chin and jaw, higher in the middle (the moustache) and lower at the cheeks
            front = head & ~hair & (z > 0.03) & (y > neck_y + 0.03)
            reg[front & (y < eyes[1] - 0.056 - 0.03 * np.clip(ax / 0.09, 0, 1))] = 7
        return reg

    pos, nrm, uv, jt, wt, idx = refine(pos, nrm, uv, jt, wt, idx, classify, passes=int(os.environ.get("PASSES", "3")))
    cen = pos[idx].mean(axis=1)
    reg = classify(cen)
    m = len(idx)
    # a little smoothing of stray triangles (each takes the region most of its neighbours are in), once: the boundaries are already clean
    nv = len(pos)
    cnt = np.zeros((nv, 8), np.int32)
    for c in range(3): np.add.at(cnt, (idx[:, c], reg), 1)
    vote = cnt[idx].sum(axis=1)
    new = vote.argmax(axis=1).astype(np.int32)
    reg = np.where(vote[np.arange(m), new] > vote[np.arange(m), reg] * 1.5, new, reg)
    reg[reg == 3] = 2  # no chest panel
    tri = reg
    # new geometry buffers (the whole mesh is rewritten: the refined one)
    wt = wt / np.maximum(wt.sum(axis=1, keepdims=True), 1e-9)
    A["POSITION"] = add_accessor(js, blob, pos.astype(np.float32), 5126, "VEC3", 34962)
    A["NORMAL"] = add_accessor(js, blob, nrm.astype(np.float32), 5126, "VEC3", 34962)
    A["TEXCOORD_0"] = add_accessor(js, blob, uv.astype(np.float32), 5126, "VEC2", 34962)
    A["JOINTS_0"] = add_accessor(js, blob, jt.astype(np.uint16), 5123, "VEC4", 34962)
    A["WEIGHTS_0"] = add_accessor(js, blob, wt.astype(np.float32), 5126, "VEC4", 34962)
    names = ["skin", "hair", "coat", "vest", "trou", "boot", "collar", "beard"]
    prims = []
    mats = []
    for k, nm in enumerate(names):
        sel = idx[tri == k]
        if not len(sel): continue
        ai = add_accessor(js, blob, sel.astype(np.uint32).reshape(-1), 5125, "SCALAR", 34963)
        c = srgb2lin(hexc(o[nm] if nm in o else o["skin"]))
        mats.append({"name": nm, "pbrMetallicRoughness": {"baseColorFactor": [float(c[0]), float(c[1]), float(c[2]), 1.0], "metallicFactor": 0.0, "roughnessFactor": 1.0}})
        q = dict(P)
        q["attributes"] = dict(A)
        q["indices"] = ai
        q["material"] = len(js["materials"]) + len(mats) - 1
        prims.append(q)
    js["materials"] = js["materials"] + mats
    js["meshes"][0]["primitives"] = prims
    blob = compact(js, blob)
    write_glb(os.path.join(d, "body.glb"), js, blob)
    print(name, "dressed:", len(pos), "verts", m, "tris", {nm: int((tri == k).sum()) for k, nm in enumerate(names)})

for nm in (sys.argv[1:] or ["man", "woman", "kid"]):
    dress(nm)
