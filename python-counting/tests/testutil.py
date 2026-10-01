"""Shared helpers for the script-style tests (run from python-counting/:
`python tests/<name>.py`): makes the package importable, sets the minimal env
counting_config needs at import time, and tallies check() results."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
os.environ.setdefault('SCREEN_RESOLUTION', '[800, 600]')
os.environ.setdefault('lineA', '[(0, 0), (10, 10)]')
os.environ.setdefault('DEBUG_MODE', 'true')

_failed = []
_passed = 0


def check(name, cond, detail=''):
    global _passed
    if cond:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failed.append(name)
        print(f"  FAIL  {name} {detail}")


def finish():
    print(f"\n{_passed} passed, {len(_failed)} failed")
    sys.exit(1 if _failed else 0)
