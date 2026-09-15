"""Replay a batch diagnostic offline; --call-model makes one call, never searches."""
import argparse
import json
from pathlib import Path
from uuid import uuid4

from zhihu_m2 import batch_screening as batch


def replay(run_dir: Path, *, call_model: bool = False, output_root: Path | None = None) -> dict:
    snapshot = json.loads((run_dir / 'input.json').read_text(encoding='utf-8'))
    destination = (output_root or run_dir.parent) / ('replay-' + uuid4().hex)
    report = {'status': 'failed', 'model_calls_attempted': 0, 'search_calls_attempted': 0,
              'source_dir': str(run_dir.resolve()), 'output_dir': str(destination.resolve())}
    if call_model:
        # compile_batch saves its inputs before attempting the single model call.
        try:
            batch.compile_batch(**snapshot, diagnostic_dir=destination)
        except Exception as error:
            report['error_type'] = type(error).__name__
        if (destination / 'report.json').exists():
            report.update(json.loads((destination / 'report.json').read_text(encoding='utf-8')))
            batch._write_diagnostic(destination / 'report.json', report)
        return report
    destination.mkdir(parents=True, mode=0o700)
    try:
        payload = json.loads((run_dir / 'model_response.json').read_text(encoding='utf-8'))
        result = batch.validate_batch_response(payload, **snapshot, diagnostic=report)
        batch._write_diagnostic(destination / 'validated.json', result)
        report.update(status='partial' if result['issues'] else 'passed', stage='finished', evidence_count=sum(
            len(item['evidence_cards']) for item in result['compilerOutputs']))
    except Exception as error:
        report['error_type'] = type(error).__name__
    batch._write_diagnostic(destination / 'report.json', report)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', required=True, type=Path)
    parser.add_argument('--output-root', type=Path)
    parser.add_argument('--call-model', action='store_true')
    args = parser.parse_args(argv)
    report = replay(args.input_dir, call_model=args.call_model, output_root=args.output_root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] in {'passed', 'partial'} else 1


if __name__ == '__main__':
    raise SystemExit(main())
