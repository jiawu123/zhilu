"""Replay synthetic ranker pairs locally; no searches, models, or environment files.

Run from the repository root. Pair preferences are engineering expectations,
not human-reviewed evidence labels or a measurement of real-world quality.
"""
import argparse
import json
import math
from pathlib import Path
import sys


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from zhihu_m2 import ranker
from zhihu_m2.models import ZhihuResult


MAX_CASE_BYTES = 2 * 1024 * 1024
DEFAULT_NOW_TS = 1_800_000_000


def _text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('invalid fixture text')
    value.encode('utf-8', errors='strict')


def _validate_dataset(dataset):
    if (not isinstance(dataset, dict) or
            set(dataset) != {'dataset_kind', 'review_status', 'cases'} or
            dataset['dataset_kind'] != 'synthetic_engineering_regression' or
            dataset['review_status'] != 'needs_human_review' or
            not isinstance(dataset['cases'], list) or not 1 <= len(dataset['cases']) <= 1000):
        raise ValueError('invalid synthetic fixture')
    seen = set()
    for case in dataset['cases']:
        if not isinstance(case, dict) or set(case) != {'id', 'domain', 'question', 'preferred', 'distractor'}:
            raise ValueError('invalid synthetic pair')
        for key, maximum in (('id', 100), ('domain', 100), ('question', 5000)):
            _text(case[key], maximum)
        if case['id'] in seen:
            raise ValueError('duplicate fixture id')
        seen.add(case['id'])
        for name in ('preferred', 'distractor'):
            candidate = case[name]
            if not isinstance(candidate, dict) or set(candidate) != {'title', 'content_text'}:
                raise ValueError('invalid candidate')
            _text(candidate['title'], 2000)
            _text(candidate['content_text'], 20_000)


def _result(candidate):
    # Both candidates receive identical metadata. Titles/snippets alone differ;
    # popularity, source identity, dates, and author cannot favor either label.
    return ZhihuResult(
        title=candidate['title'], content_text=candidate['content_text'],
        content_type='Answer', content_id='synthetic',
        author_name='Synthetic fixture', author_signature='synthetic', author_badge_text='',
        url='https://www.zhihu.com/question/1/answer/1',
        vote_up_count=0, comment_count=0, authority_level='', ranking_score=0.0, edit_time=0,
    )


def evaluate_dataset(dataset, *, now_ts=DEFAULT_NOW_TS):
    """Return deterministic priorities; never treat pair labels as real quality."""
    _validate_dataset(dataset)
    if type(now_ts) not in (int, float) or not math.isfinite(now_ts):
        raise ValueError('invalid evaluation time')
    report = {
        'ranker_version': ranker.RANKER_VERSION,
        'score_kind': 'heuristic_priority_not_fact_confidence',
        'review_status': 'needs_human_review',
        'scope': 'synthetic_engineering_regression_only',
        'now_ts': now_ts,
        'case_count': len(dataset['cases']),
        'preferred_first_count': 0, 'tied_count': 0, 'distractor_first_count': 0,
        'domains': {}, 'cases': [],
        'execution': {'search_calls_attempted': 0, 'model_calls_attempted': 0},
        'warnings': ['synthetic_preferences_are_not_human_reviewed_quality_labels'],
    }
    for case in dataset['cases']:
        preferred, distractor = _result(case['preferred']), _result(case['distractor'])
        question = case['question']
        breakdowns = {
            'preferred': ranker.ranking_breakdown(preferred, question, now_ts=now_ts),
            'distractor': ranker.ranking_breakdown(distractor, question, now_ts=now_ts),
        }
        # Distractor is first so a stable tie cannot be reported as a preference win.
        ordered = ranker.rank_results([distractor, preferred], question, now_ts=now_ts)
        if breakdowns['preferred']['score'] == breakdowns['distractor']['score']:
            outcome, count_key = 'tied', 'tied_count'
        elif ordered[0] is preferred:
            outcome, count_key = 'preferred_first', 'preferred_first_count'
        else:
            outcome, count_key = 'distractor_first', 'distractor_first_count'
        report[count_key] += 1
        domain = report['domains'].setdefault(case['domain'], {
            'case_count': 0, 'preferred_first_count': 0, 'tied_count': 0, 'distractor_first_count': 0,
        })
        domain['case_count'] += 1
        domain[count_key] += 1
        report['cases'].append({'id': case['id'], 'domain': case['domain'],
                                'question': question, 'outcome': outcome, **breakdowns})
    if report['preferred_first_count'] != report['case_count']:
        report['warnings'].append('synthetic_preferences_not_all_met')
    return report


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError('nonfinite JSON value')


def _load_dataset(path):
    with path.open('rb') as stream:
        content = stream.read(MAX_CASE_BYTES + 1)
    if len(content) > MAX_CASE_BYTES:
        raise ValueError('case file exceeds limit')
    return json.loads(content.decode('utf-8-sig'), object_pairs_hook=_json_object,
                      parse_constant=_reject_constant)


class _SafeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, 'Evaluation failed: invalid command arguments; use --help.\n')


def main():
    parser = _SafeParser(description='Replay unreviewed synthetic ranker pairs offline; no searches or model calls.')
    parser.add_argument('--case-file', type=Path,
                        default=PACKAGE_ROOT / 'tests/fixtures/ranker_cross_domain.json')
    parser.add_argument('--output', type=Path, default=PACKAGE_ROOT / 'artifacts/ranker-cross-domain.json')
    parser.add_argument('--now-ts', default=str(DEFAULT_NOW_TS), help='Finite evaluation timestamp (default: 1800000000).')
    args = parser.parse_args()
    try:
        report = evaluate_dataset(_load_dataset(args.case_file), now_ts=float(args.now_ts))
        content = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding='utf-8')
    except Exception:
        # This is the CLI boundary: unexpected provider/module errors are never
        # echoed alongside fixture contents, exception messages, or credentials.
        parser.exit(2, 'Evaluation failed: invalid case file, evaluation time, ranking output, or output path.\n')
    summary = {key: report[key] for key in ('ranker_version', 'score_kind', 'scope', 'review_status',
               'case_count', 'preferred_first_count', 'tied_count', 'distractor_first_count', 'execution', 'warnings')}
    print(json.dumps(summary, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
