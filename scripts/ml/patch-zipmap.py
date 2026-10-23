"""
Make the Oracle ML ensemble return real probabilities to onnxruntime-node.

Problem: the shipped fold_*.onnx files end in a ZipMap node, so their
`probabilities` output is a sequence<map<int64,float>>. onnxruntime-node cannot
fetch non-tensor outputs ("Non tensor type is temporarily not supported"), so
electron/ml-model.ts silently fell back to the int64 `label` output and every
score was an average of eight 0/1 votes.

Fix (no retraining, no autogluon needed): remove the ZipMap node and promote the
float probability tensor feeding it to the graph output named `probabilities`.

Usage:
  python scripts/ml/patch-zipmap.py <ensemble_dir> [--out <dir>] [--check-only]

  --out         write patched models there (default: in place, originals kept as *.orig.onnx)
  --check-only  report whether each fold still has ZipMap; change nothing

After patching, each fold is validated with onnxruntime: `probabilities` must be a
float tensor [N, 2] and argmax(probabilities) must equal the `label` output on
random inputs (>= 99.9% agreement) — otherwise the script exits non-zero.
"""
import argparse
import glob
import os
import shutil
import sys

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper


def patch_model(path_in: str, path_out: str) -> str:
    model = onnx.load(path_in)
    graph = model.graph
    zip_nodes = [n for n in graph.node if n.op_type == "ZipMap"]
    if not zip_nodes:
        if path_in != path_out:
            shutil.copyfile(path_in, path_out)
        return "no-zipmap"
    if len(zip_nodes) != 1:
        raise RuntimeError(f"{path_in}: expected exactly one ZipMap node, found {len(zip_nodes)}")

    zipmap = zip_nodes[0]
    prob_tensor = zipmap.input[0]          # float [N, n_classes] produced by TreeEnsembleClassifier
    zipped_name = zipmap.output[0]         # 'probabilities' (the sequence<map> graph output)

    graph.node.remove(zipmap)

    # Drop the sequence<map> graph output and any value_info for it.
    for out in [o for o in graph.output if o.name == zipped_name]:
        graph.output.remove(out)
    for vi in [v for v in graph.value_info if v.name == zipped_name]:
        graph.value_info.remove(vi)

    # Rename the producer's tensor to the freed output name so the model keeps the
    # output contract ["label", "probabilities"] that feature_spec.json declares.
    renamed = False
    for node in graph.node:
        for i, name in enumerate(node.output):
            if name == prob_tensor:
                node.output[i] = zipped_name
                renamed = True
    if not renamed:
        raise RuntimeError(f"{path_in}: no node produces ZipMap input '{prob_tensor}'")
    for node in graph.node:
        for i, name in enumerate(node.input):
            if name == prob_tensor:
                node.input[i] = zipped_name
    for vi in [v for v in graph.value_info if v.name == prob_tensor]:
        graph.value_info.remove(vi)

    graph.output.append(
        helper.make_tensor_value_info(zipped_name, TensorProto.FLOAT, [None, 2])
    )
    onnx.checker.check_model(model)
    onnx.save(model, path_out)
    return "patched"


def validate(path: str, n_features: int, rows: int = 2000) -> None:
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    names = [o.name for o in sess.get_outputs()]
    if names != ["label", "probabilities"]:
        raise RuntimeError(f"{path}: outputs are {names}, expected ['label', 'probabilities']")
    prob_type = sess.get_outputs()[1].type
    if prob_type != "tensor(float)":
        raise RuntimeError(f"{path}: probabilities type is {prob_type}, expected tensor(float)")

    rng = np.random.default_rng(7)
    x = rng.random((rows, n_features), dtype=np.float32)
    label, prob = sess.run(None, {sess.get_inputs()[0].name: x})
    if prob.shape != (rows, 2):
        raise RuntimeError(f"{path}: probabilities shape {prob.shape}")
    if not np.allclose(prob.sum(axis=1), 1.0, atol=1e-3):
        raise RuntimeError(f"{path}: probabilities rows do not sum to 1")
    agree = float((prob.argmax(axis=1) == label).mean())
    if agree < 0.999:
        raise RuntimeError(f"{path}: argmax(prob) agrees with label on only {agree:.4f}")
    spread = float(np.unique(np.round(prob[:, 1], 4)).size)
    print(f"  ok  {os.path.basename(path)}  agree={agree:.4f}  distinct_p1={int(spread)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ensemble_dir")
    ap.add_argument("--out")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--features", type=int, default=242)
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.ensemble_dir, "fold_*.onnx")))
    files = [f for f in files if not f.endswith(".orig.onnx")]
    if not files:
        print("no fold_*.onnx files found", file=sys.stderr)
        return 2

    if args.check_only:
        for f in files:
            has = any(n.op_type == "ZipMap" for n in onnx.load(f).graph.node)
            print(f"  {os.path.basename(f)}: {'ZipMap present' if has else 'tensor probabilities'}")
        return 0

    out_dir = args.out or args.ensemble_dir
    os.makedirs(out_dir, exist_ok=True)
    for f in files:
        dst = os.path.join(out_dir, os.path.basename(f))
        if out_dir == args.ensemble_dir:
            backup = f.replace(".onnx", ".orig.onnx")
            if not os.path.exists(backup):
                shutil.copyfile(f, backup)
        result = patch_model(f, dst)
        print(f"{os.path.basename(f)}: {result}")
        validate(dst, args.features)
    print("all folds validated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
