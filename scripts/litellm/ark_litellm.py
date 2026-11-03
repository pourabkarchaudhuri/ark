"""Launcher for Ark's bundled LiteLLM sidecar (1.0.97 B35).

Started by electron/litellm-sidecar.ts as `python -I ark_litellm.py --config <file> --port <n>`.
Runs LiteLLM's OpenAI-compatible proxy on 127.0.0.1 only. Everything secret arrives through the
environment (LITELLM_MASTER_KEY and the ARK_KEY_* variables the generated config refers to as
`os.environ/ARK_KEY_...`), never through argv or the config file.
"""
import argparse
import os
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ark_litellm")
    parser.add_argument("--config", required=True, help="generated LiteLLM config (YAML/JSON)")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        sys.stderr.write("ark_litellm: refusing to bind a non-loopback address\n")
        return 2
    if not os.environ.get("LITELLM_MASTER_KEY"):
        sys.stderr.write("ark_litellm: LITELLM_MASTER_KEY is not set\n")
        return 2
    if not os.path.isfile(args.config):
        sys.stderr.write("ark_litellm: config file not found\n")
        return 2

    # Offline-friendly and quiet: no cost-map download, no telemetry, no admin UI, no database.
    os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    os.environ.setdefault("LITELLM_TELEMETRY", "False")
    os.environ.setdefault("DISABLE_ADMIN_UI", "True")
    os.environ.setdefault("LITELLM_DONT_SHOW_FEEDBACK_BOX", "True")
    os.environ.setdefault("LITELLM_LOG", "ERROR")
    os.environ.pop("DATABASE_URL", None)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    from litellm.proxy.proxy_cli import run_server

    sys.argv = ["litellm", "--config", args.config, "--host", args.host, "--port", str(args.port), "--num_workers", "1"]
    run_server()
    return 0


if __name__ == "__main__":
    sys.exit(main())
