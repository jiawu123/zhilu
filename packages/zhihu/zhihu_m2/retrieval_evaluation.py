"""Offline fixed-pool evaluation. Labels are evidence, never model scores.

Synthetic source grades may be overridden by source-local occurrence indexes.
Real grades must be variant label records with an explicit human review status.
No client, compiler, dotenv, network or saved artifact is imported here.
"""
import math


def _keys(keys):
    if any(type(key) is not str or not key for key in keys):
        raise ValueError('result keys must be nonempty strings')
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate result key')


def _grade(value):
    if type(value) is not int or not 0 <= value <= 3:
        raise ValueError('grade must be an integer from 0 to 3')
    return value


def precision_at_k(result_keys: list[str], grades: dict[str, int], k: int = 3) -> float:
    """Direct-answer precision, retaining a fixed denominator for short output."""
    if type(k) is not int or k <= 0:
        raise ValueError('k must be a positive integer')
    _keys(result_keys)
    for value in grades.values():
        _grade(value)
    if any(key not in grades for key in result_keys):
        raise ValueError('unjudged result key')
    return sum(grades[key] >= 2 for key in result_keys[:k]) / k


def pairwise_preference_pass(order: list[str], preferred: str, other: str) -> bool:
    _keys(order)
    if preferred == other or preferred not in order or other not in order:
        raise ValueError('pair requires two distinct ranked results')
    return order.index(preferred) < order.index(other)


def validate_source_uniqueness(result_keys: list[str]) -> None:
    _keys(result_keys)
    sources = [key.rsplit('@', 1)[0] for key in result_keys]
    if len(sources) != len(set(sources)):
        raise ValueError('duplicate source in selected results')


def _label_map(case, pool):
    from zhihu_m2.candidate_pool import variant_key
    labels = {}

    def add(key, grade):
        _grade(grade)
        if key in labels and labels[key] != grade:
            raise ValueError('conflicting labels for identical variant')
        labels[key] = grade

    raw = case.get('grades')
    if case.get('synthetic') is True:
        defaults = raw or {}
        if type(defaults) is not dict:
            raise ValueError('synthetic grades must be a mapping')
        for grade in defaults.values():
            _grade(grade)
        overrides = case.get('checks', {}).get('grade_by_occurrence', {})
        for candidate in pool:
            for index, occurrence in enumerate(candidate.occurrences):
                grade = overrides.get(candidate.source_id, {}).get(str(index), defaults.get(candidate.source_id))
                if grade is not None:
                    add(candidate.source_id + '@' + variant_key(occurrence), grade)
        return labels
    if raw is None:
        return labels
    if type(raw) is not list:
        raise ValueError('real grades require variant label records')
    known_variants = {candidate.source_id + '@' + variant_key(o) for candidate in pool for o in candidate.occurrences}
    all_labels = {}
    for label in raw:
        if type(label) is not dict or not label.get('source_id') or not label.get('variant_key'):
            raise ValueError('real grades require source and variant')
        key = label['source_id'] + '@' + label['variant_key']
        if key not in known_variants:
            raise ValueError('label refers to unknown variant')
        grade = label.get('task_fit_grade')
        if grade is not None:
            _grade(grade)
            if key in all_labels and all_labels[key] != grade:
                raise ValueError('conflicting labels for identical variant')
            all_labels[key] = grade
        if label.get('review_status') == 'human_reviewed':
            if not label.get('reviewer'):
                raise ValueError('human label requires reviewer')
            add(key, grade)
    return labels


def evaluate_case(case: dict, profiles=('legacy', 'v3')) -> dict:
    """Compare frozen occurrences; selection_simulation assumes selection succeeds.

    It is not accepted-card or end-to-end evaluation. Real compilation labels and
    actual capture attempt counts remain separate from this zero-call replay.
    """
    from zhihu_m2.candidate_pool import SearchOccurrence, build_candidate_pool, variant_key
    from zhihu_m2.models import ZhihuResult
    from zhihu_m2.ranker import rank_results

    if not profiles or any(profile not in {'legacy', 'v3'} for profile in profiles):
        raise ValueError('unknown evaluation profile')
    request = case['request']
    observations = case.get('observations', [])
    occurrences = [SearchOccurrence(item['query_index'], item['result_rank'], item['retrieved_at'], ZhihuResult(**item['result'])) for item in observations]
    candidates = build_candidate_pool(occurrences)
    pool = {candidate.source_id: candidate for candidate in candidates}
    labels = _label_map(case, candidates)
    now = case.get('now_ts')
    if observations and (type(now) not in (int, float) or not math.isfinite(now)):
        raise ValueError('captured cases require finite now_ts for reproducibility')
    orders = {}
    if 'legacy' in profiles:
        first = [candidate.occurrences[0].result for candidate in candidates]
        ranked = rank_results(first, query=request['question'], now_ts=now)
        orders['legacy'] = [(f'zhihu:{result.content_type}:{result.content_id}', 0) for result in ranked]
    if 'v3' in profiles:
        from zhihu_m2.ranker_v3 import RankingContext, rank_candidates, select_next_source
        context = RankingContext(request['question'], tuple(request['searchQueries']), bool(request.get('freshness')), now or 0.0)
        ranked = rank_candidates(candidates, context, set(case.get('successful_query_indexes', [])))
        orders['v3_no_diversity'] = [(item.source_id, item.representative_index) for item in ranked]
        simulated = []
        selected = set()
        while len(simulated) < min(3, len(ranked)):
            item = select_next_source(ranked, pool, selected, selected)
            if item is None or item.source_id in selected:
                raise ValueError('invalid selection simulation')
            simulated.append((item.source_id, item.representative_index))
            selected.add(item.source_id)
        orders['selection_simulation'] = simulated
    ablations = {}
    for name, order in orders.items():
        keys = [sid + '@' + variant_key(pool[sid].occurrences[index]) for sid, index in order]
        validate_source_uniqueness(keys)
        top = keys[:3]
        judged = case.get('capture_status') != 'not_collected' and (case.get('synthetic') is True or bool(top) and bool(labels)) and all(key in labels for key in top)
        precision = precision_at_k(top, labels) if judged else None
        source_order = [sid for sid, _ in order]
        preferences = case.get('pairwise_preferences', []) if case.get('synthetic') is True else []
        pairwise = [pairwise_preference_pass(source_order, pair['preferred'], pair['other']) for pair in preferences] if name != 'selection_simulation' else []
        ablations[name] = {'selected_result_keys': top, 'ordered_result_keys': keys,
            'precision_at_3': precision, 'pairwise_preferences': pairwise,
            'quality_status': 'synthetic_regression' if case.get('synthetic') is True else 'human_reviewed' if judged else 'needs_human_review',
            'accepted_card_precision': None, 'question_success': None, 'unsupported_count': None,
            'uncertain_count': None, 'redundancy': None, 'compiler_status': 'not_run'}
        if name == 'selection_simulation':
            ablations[name]['simulation_note'] = 'Top-three preselection only; selected sources are assumed accepted for diversity. No actual accepted cards.'
    return {'case_id': case['case_id'], 'split': case.get('split'), 'synthetic': case.get('synthetic') is True,
        'quality_status': 'synthetic_regression' if case.get('synthetic') is True else 'human_reviewed' if all(a['quality_status'] == 'human_reviewed' for a in ablations.values()) else 'needs_human_review',
        'capture_status': case.get('capture_status'), 'candidate_capture_id': case.get('candidate_capture_id'),
        'candidate_capture_time': case.get('candidate_capture_time'),
        'capture_engineering_metrics': case.get('engineering_metrics'),
        'candidate_count': len(pool), 'valid_occurrence_count': len(occurrences),
        'variant_count': len({(candidate.source_id, variant_key(o)) for candidate in candidates for o in candidate.occurrences}),
        'ablations': ablations}


def evaluate_dataset(dataset: dict, profiles=('legacy', 'v3')) -> dict:
    cases = dataset.get('cases', dataset.get('questions'))
    if type(cases) is not list or not cases:
        raise ValueError('case file must contain cases or questions')
    _keys([case['case_id'] for case in cases])
    results = [evaluate_case(case, profiles) for case in cases]
    synthetic = all(case['synthetic'] for case in results)
    summary = {}
    for name in results[0]['ablations']:
        # Keep synthetic and human data separate even in a mixed input file.
        summary[name] = {}
        for group in ('synthetic_regression', 'development', 'holdout', 'unspecified'):
            group_cases = [case for case in results if ('synthetic_regression' if case['synthetic'] else case['split'] or 'unspecified') == group]
            values = [case['ablations'][name]['precision_at_3'] for case in group_cases if case['ablations'][name]['precision_at_3'] is not None]
            if group_cases:
                summary[name][group] = {'case_count': len(group_cases), 'judged_case_count': len(values), 'mean_precision_at_3': sum(values) / len(values) if values else None}
    paired_summary = {}
    names = tuple(results[0]['ablations'])
    for group in ('synthetic_regression', 'development', 'holdout', 'unspecified'):
        group_cases = [case for case in results if ('synthetic_regression' if case['synthetic'] else case['split'] or 'unspecified') == group]
        if not group_cases:
            continue
        paired = [case for case in group_cases if all(case['ablations'][name]['precision_at_3'] is not None for name in names)]
        paired_summary[group] = {'case_ids': [case['case_id'] for case in paired],
            'judged_case_count': len(paired), 'case_count': len(group_cases),
            'mean_precision_at_3': {name: sum(case['ablations'][name]['precision_at_3'] for case in paired) / len(paired) if paired else None for name in names}}
    return {'schema_version': 'zhihu-retrieval-evaluation-v1',
        'evaluation_scope': 'synthetic_regression' if synthetic else 'fixed_candidate_pool',
        'quality_status': 'synthetic_regression' if synthetic else 'needs_human_review' if any(case['quality_status'] == 'needs_human_review' for case in results) else 'human_reviewed',
        'execution': {'mode': 'offline', 'search_calls_attempted': 0, 'compiler_calls_attempted': 0, 'planner_calls_attempted': 0},
        'summary': summary, 'paired_summary': paired_summary, 'cases': results}
