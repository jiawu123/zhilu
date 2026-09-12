import copy
import json
from pathlib import Path

import pytest

from zhihu_m2 import retrieval_evaluation as evaluation


def test_precision_fixed_denominator_and_grade_boundary():
    assert evaluation.precision_at_k(['a'], {'a': 3}) == pytest.approx(1 / 3)
    assert evaluation.precision_at_k([], {}) == 0
    assert evaluation.precision_at_k(['a', 'b', 'c', 'd'], dict(a=0, b=1, c=2, d=3), 4) == .5


@pytest.mark.parametrize('k', [True, False, 0, -1, 1.0, '3'])
def test_invalid_k(k):
    with pytest.raises(ValueError):
        evaluation.precision_at_k([], {}, k)


@pytest.mark.parametrize('grade', [True, False, -1, 4, 2.0, '2', None])
def test_invalid_grade(grade):
    with pytest.raises(ValueError):
        evaluation.precision_at_k(['a'], {'a': grade})


def test_unknown_and_duplicate_results_rejected_even_beyond_cutoff():
    for keys, grades in [(['a'], {}), (['a', 'a'], {'a': 3}), (['a', 'b'], {'a': 3})]:
        with pytest.raises(ValueError):
            evaluation.precision_at_k(keys, grades, 1)


def test_pairwise_validates_complete_unique_order():
    assert evaluation.pairwise_preference_pass(['a', 'b'], 'a', 'b') is True
    assert evaluation.pairwise_preference_pass(['b', 'a'], 'a', 'b') is False
    for order, preferred, other in [(['a'], 'a', 'b'), (['a', 'a', 'b'], 'a', 'b'), (['a'], 'a', 'a')]:
        with pytest.raises(ValueError):
            evaluation.pairwise_preference_pass(order, preferred, other)


def test_same_source_two_variants_cannot_fill_two_positions():
    with pytest.raises(ValueError):
        evaluation.validate_source_uniqueness(['zhihu:Article:a@x', 'zhihu:Article:a@y'])


def synthetic_case():
    data = json.loads((Path(__file__).parent / 'fixtures/retrieval_v3/synthetic_cases.json').read_text(encoding='utf-8'))
    return next(case for case in data['cases'] if 'grade_by_occurrence' in case.get('checks', {}))


def test_variant_override_is_used_and_conflicting_identical_variant_rejected():
    case = synthetic_case()
    report = evaluation.evaluate_case(case, profiles=['legacy'])
    assert report['ablations']['legacy']['precision_at_3'] == 0
    case['observations'][1]['result'] = copy.deepcopy(case['observations'][0]['result'])
    with pytest.raises(ValueError, match='conflict'):
        evaluation.evaluate_case(case, profiles=['legacy'])


def test_real_source_only_labels_rejected_and_unreviewed_variants_not_scored():
    case = synthetic_case()
    case['synthetic'] = False
    with pytest.raises(ValueError, match='variant'):
        evaluation.evaluate_case(case, profiles=['legacy'])
    case['grades'] = None
    result = evaluation.evaluate_case(case, profiles=['legacy'])
    assert result['quality_status'] == 'needs_human_review'
    assert result['ablations']['legacy']['precision_at_3'] is None
    key = result['ablations']['legacy']['selected_result_keys'][0]
    source_id, variant_key = key.rsplit('@', 1)
    case['grades'] = [dict(source_id=source_id, variant_key=variant_key, task_fit_grade=3, review_status='model_proposed')]
    assert evaluation.evaluate_case(case, ['legacy'])['ablations']['legacy']['precision_at_3'] is None
    case['grades'][0].update(review_status='human_reviewed', reviewer='fixture-human')
    assert evaluation.evaluate_case(case, ['legacy'])['ablations']['legacy']['precision_at_3'] == pytest.approx(1 / 3)


def test_real_labels_cannot_reference_variants_outside_frozen_pool():
    case = synthetic_case()
    case.update(synthetic=False, grades=[dict(source_id='zhihu:Article:variant', variant_key='wrong-hash', task_fit_grade=3, review_status='human_reviewed', reviewer='fixture-human')])
    with pytest.raises(ValueError, match='unknown variant'):
        evaluation.evaluate_case(case, ['legacy'])


def test_conflicting_real_label_records_rejected_even_if_model_proposed():
    case = synthetic_case()
    case.update(synthetic=False, grades=None)
    key = evaluation.evaluate_case(case, ['legacy'])['ablations']['legacy']['selected_result_keys'][0]
    sid, variant = key.rsplit('@', 1)
    case['grades'] = [dict(source_id=sid, variant_key=variant, task_fit_grade=grade, review_status='model_proposed') for grade in (1, 3)]
    with pytest.raises(ValueError, match='conflict'):
        evaluation.evaluate_case(case, ['legacy'])


def test_replay_is_deterministic_and_preserves_input():
    case = synthetic_case()
    original = copy.deepcopy(case)
    report = evaluation.evaluate_dataset({'cases': [case]})
    assert report == evaluation.evaluate_dataset({'cases': [case]})
    assert case == original
    assert report['cases'][0]['ablations']['v3_no_diversity']['precision_at_3'] == pytest.approx(1 / 3)


def test_mixed_dataset_never_pools_synthetic_and_human_means():
    synthetic = synthetic_case()
    real = copy.deepcopy(synthetic)
    real.update(case_id='pending-real', synthetic=False, grades=None, split='holdout')
    report = evaluation.evaluate_dataset({'cases': [synthetic, real]})
    assert report['summary']['legacy']['holdout']['mean_precision_at_3'] is None
    assert report['summary']['legacy']['synthetic_regression']['judged_case_count'] == 1


def test_empty_real_label_list_does_not_assert_human_review():
    case = synthetic_case()
    case.update(synthetic=False, observations=[], grades=[], capture_status='captured')
    result = evaluation.evaluate_case(case)
    assert result['quality_status'] == 'needs_human_review'
    assert result['ablations']['legacy']['precision_at_3'] is None


def test_paired_summary_excludes_questions_unjudged_for_any_ablation():
    case = synthetic_case()
    case.update(synthetic=False, grades=None, split='development')
    key = evaluation.evaluate_case(case)['ablations']['legacy']['selected_result_keys'][0]
    sid, variant = key.rsplit('@', 1)
    case['grades'] = [dict(source_id=sid, variant_key=variant, task_fit_grade=3, review_status='human_reviewed', reviewer='fixture-human')]
    report = evaluation.evaluate_dataset({'cases': [case]})
    paired = report['paired_summary']['development']
    assert paired['case_ids'] == []
    assert paired['judged_case_count'] == 0
    assert paired['mean_precision_at_3'] == dict(legacy=None, v3_no_diversity=None, selection_simulation=None)
