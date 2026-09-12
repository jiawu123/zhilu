"""Offline retrieval replay; executable from the repository root."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from zhihu_m2.retrieval_evaluation import evaluate_dataset


def main():
    parser = argparse.ArgumentParser(description='Evaluate a frozen candidate pool without any network or model calls.')
    parser.add_argument('--case-file', required=True, type=Path)
    parser.add_argument('--profiles', nargs='+', choices=['legacy', 'v3'], default=['legacy', 'v3'])
    parser.add_argument('--offline', action='store_true', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        dataset = json.loads(args.case_file.read_text(encoding='utf-8-sig'))
        report = evaluate_dataset(dataset, args.profiles)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError):
        parser.exit(2, 'Evaluation failed: invalid case file, labels, ranking output, or output path.\n')
    print(json.dumps({'evaluation_scope': report['evaluation_scope'], 'quality_status': report['quality_status'], 'case_count': len(report['cases'])}))


if __name__ == '__main__':
    main()
