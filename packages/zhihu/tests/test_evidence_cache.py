"""Offline cache round-trips preserve compiler provenance, never execution failures."""
import copy
import hashlib
import importlib
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from zhihu_m2.evidence_compiler import validate_evidence_response
from zhihu_m2.normalizer import normalize_result


def payload():
    return {'goal': '学会做面包', 'user_context': {'experience': 'beginner', 'hours': 4},
            'request': {'id': '../controller-id', 'question': '如何判断面团发酵完成？',
                        'searchQueries': ['面团 发酵 完成 判断', '面包 发酵 过度 风险'],
                        'relevantUserConditions': ['初学者'], 'evidenceLimit': 8}}


def output(index=1, author='面包作者'):
    quote = '用手指轻按面团，观察凹痕缓慢回弹。'
    source = normalize_result({'ContentType': 'answer', 'ContentID': str(index),
        'Title': '发酵检查', 'ContentText': '🍞\r\n' + quote + '\r\n实际温度会影响时间。',
        'AuthorName': author, 'Url': f'https://www.zhihu.com/question/1/answer/{index}'})
    return validate_evidence_response({'status': 'ok', 'reason': '提供实际检查步骤',
        'evidence_cards': [{'source_id': f'zhihu:answer:{index}', 'supporting_quote': quote,
            'claim': '作者建议轻按面团观察回弹。', 'claim_type': 'advice',
            'applies_when': '初学者可结合温度尝试', 'caveats': ['温度会影响实际发酵时间。']}]},
        source, retrieved_at='2026-09-12T02:03:04+00:00')


def result(count=1):
    return {'requestId': payload()['request']['id'], 'status': 'ok' if count else 'no_evidence',
        'compilerOutputs': [output(i, author=f'作者{i}') for i in range(1, count + 1)],
        'routeCandidates': [], 'unresolvedQuestions': [] if count else ['No applicable evidence.'],
        'issues': []}


def cache(directory, **kwargs):
    module = importlib.import_module('zhihu_m2.evidence_cache')
    return module.EvidenceCache(directory, **kwargs)


def test_roundtrip_rebases_only_external_request_id_and_saves_call_counts(tmp_path):
    store = cache(tmp_path, now=lambda: 1000)
    original = result()
    assert store.get(payload()) is None
    assert store.last_status == 'miss'
    assert store.put(payload(), original,
        {'search_calls_attempted': 2, 'compiler_calls_attempted': 1, 'batch_model_calls_attempted': 1})
    changed = payload()
    changed['request']['id'] = 'second-controller-id'
    hit = store.get(changed)
    expected = copy.deepcopy(original)
    expected['requestId'] = changed['request']['id']
    assert hit == {'result': expected, 'saved_search_calls': 2, 'saved_model_calls': 2}
    assert store.last_status == 'hit'
    assert original == result()
    card = hit['result']['compilerOutputs'][0]['evidence_cards'][0]
    assert card['quote_start'] == 3  # Python code points; emoji is two JS UTF-16 units.
    assert hit['result']['compilerOutputs'][0]['source']['snippet'].startswith('🍞\r\n')
    hit['result']['compilerOutputs'][0]['evidence_cards'][0]['risk_flags'].clear()
    assert store.get(changed)['result'] == expected
    assert len(list(tmp_path.glob('*.json'))) == 1
    assert not list(tmp_path.glob('*.tmp'))


@pytest.mark.parametrize('change', [
    lambda p: p.update(goal='做低糖面包'),
    lambda p: p['user_context'].update(hours=2),
    lambda p: p['request'].update(question='发酵过度怎么办？'),
    lambda p: p['request'].update(searchQueries=['面包 发酵 过度 风险']),
    lambda p: p['request'].update(relevantUserConditions=['专业烘焙师']),
    lambda p: p['request'].update(evidenceLimit=6),
    lambda p: p['request'].update(freshness='最近一年'),
])
def test_every_research_semantic_field_invalidates_cache(tmp_path, change):
    store = cache(tmp_path)
    assert store.put(payload(), result(), {'search_calls_attempted': 2})
    changed = payload()
    change(changed)
    assert store.key(changed) != store.key(payload())
    assert store.get(changed) is None
    assert store.last_status == 'miss'


def test_canonical_keys_and_profile_and_version_isolation(tmp_path):
    store = cache(tmp_path)
    p = payload()
    p['user_context'] = dict(reversed(list(p['user_context'].items())))
    assert store.key(p) == store.key(payload())
    assert store.key(p, profile='legacy') != store.key(p)
    assert store.key(p, version='next') != store.key(p)
    assert store.put(p, result(), {})
    assert store.get(p, profile='legacy') is None
    assert store.get(p, version='next') is None
    content = next(tmp_path.glob('*.json')).read_text('utf-8')
    assert p['goal'] not in content  # Key stores a digest, not confirmed project context.


def test_expiry_and_clock_regression_are_safe_misses(tmp_path):
    times = [1000]
    store = cache(tmp_path, ttl_seconds=60, now=lambda: times[0])
    assert store.put(payload(), result(), {})
    times[0] = 1059
    assert store.get(payload())
    times[0] = 1060
    assert store.get(payload()) is None
    assert store.last_status == 'expired'
    times[0] = 999
    assert store.get(payload()) is None
    assert store.last_status == 'invalid'


def test_no_evidence_is_cacheable_but_partial_and_failure_are_not(tmp_path):
    store = cache(tmp_path)
    empty = result(0)
    assert store.put(payload(), empty, {'model_calls_attempted': 1})
    assert store.get(payload())['result'] == empty
    for status in ['partial', 'failed', 'error']:
        changed = result()
        changed['status'] = status
        assert not store.put(payload(), changed, {})
        assert store.last_status == 'invalid'
    assert store.get(payload())['result'] == empty


@pytest.mark.parametrize('change', [
    lambda r: r.update(requestId='different-request'),
    lambda r: r.update(status='no_evidence'),
    lambda r: r.update(issues=[{'code': 'compiler_failed'}]),
    lambda r: r.update(authorization='credential-canary'),
    lambda r: r['compilerOutputs'][0]['source'].update(snippet='tampered'),
    lambda r: r['compilerOutputs'][0]['source'].update(retrievedAt='not-a-date'),
    lambda r: r['compilerOutputs'][0]['source'].update(url='https://user:secret@zhihu.com'),
    lambda r: r['compilerOutputs'][0]['evidence_cards'][0].update(quote_start=True),
    lambda r: r['compilerOutputs'][0]['evidence_cards'][0].update(risk_flags=[]),
    lambda r: r['compilerOutputs'][0]['evidence_cards'][0].update(verification_status='verified'),
    lambda r: r.update(routeCandidates=[{'id': 'r', 'title': '方法', 'summary': '选项',
        'applicableWhen': ['初学者'], 'evidenceIds': ['missing'], 'risks': []}]),
])
def test_invalid_or_tampered_results_are_not_written(tmp_path, change):
    store = cache(tmp_path)
    value = result()
    change(value)
    assert not store.put(payload(), value, {})
    assert store.last_status == 'invalid'
    assert not list(tmp_path.glob('*.json'))


@pytest.mark.parametrize('metrics', [
    {'search_calls_attempted': True}, {'model_calls_attempted': -1},
    {'compiler_calls_attempted': float('nan')},
])
def test_metrics_reject_boolean_negative_and_nonfinite(tmp_path, metrics):
    store = cache(tmp_path)
    assert not store.put(payload(), result(), metrics)
    assert store.get(payload()) is None


def test_explicit_total_model_count_does_not_double_count(tmp_path):
    store = cache(tmp_path)
    assert store.put(payload(), result(), {'model_calls_attempted': 2,
        'compiler_calls_attempted': 2, 'batch_model_calls_attempted': 1})
    assert store.get(payload())['saved_model_calls'] == 2


@pytest.mark.parametrize('content', [b'not json', b'{"token":"credential-canary"}',
    b'[]', b'\xff', b'x' * (2 * 1024 * 1024 + 1)],
    ids=['invalid-json', 'unsafe-fields', 'array', 'invalid-utf8', 'oversize'])
def test_malformed_oversize_records_never_escape_or_echo(tmp_path, content, capsys):
    store = cache(tmp_path)
    assert store.put(payload(), result(), {})
    next(tmp_path.glob('*.json')).write_bytes(content)
    assert store.get(payload()) is None
    assert store.last_status == 'invalid'
    assert capsys.readouterr() == ('', '')


def test_stored_record_integrity_is_checked(tmp_path):
    store = cache(tmp_path)
    assert store.put(payload(), result(), {})
    path = next(tmp_path.glob('*.json'))
    record = json.loads(path.read_text('utf-8'))
    record['result']['compilerOutputs'][0]['reason'] = 'changed outside cache writer'
    path.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
    assert store.get(payload()) is None
    assert store.last_status == 'invalid'


@pytest.mark.parametrize('change', [
    lambda r: r.update(protocol='unrelated-protocol'),
    lambda r: r.update(key='0' * 64),
    lambda r: r.update(saved_model_calls=True),
    lambda r: r.update(expiresAt=True),
    lambda r: r['result']['compilerOutputs'][0]['evidence_cards'][0].update(risk_flags=[]),
    lambda r: r['result'].update(issues=[{'code': 'compiler_failed'}]),
])
def test_runtime_validation_rejects_invalid_records_even_with_recomputed_checksum(tmp_path, change):
    store = cache(tmp_path)
    assert store.put(payload(), result(), {})
    path = next(tmp_path.glob('*.json'))
    record = json.loads(path.read_text('utf-8'))
    change(record)
    content = {key: value for key, value in record.items() if key != 'sha256'}
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    record['sha256'] = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    path.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
    assert store.get(payload()) is None
    assert store.last_status == 'invalid'


def test_runtime_ttl_can_shorten_an_existing_record_lifetime(tmp_path):
    assert cache(tmp_path, ttl_seconds=1000, now=lambda: 1000).put(payload(), result(), {})
    shorter = cache(tmp_path, ttl_seconds=60, now=lambda: 1060)
    assert shorter.get(payload()) is None
    assert shorter.last_status == 'expired'


def test_unavailable_cache_never_blocks_research_or_exposes_exceptions(tmp_path, capsys):
    path = tmp_path / 'credential-canary'
    path.write_text('a file cannot be a cache directory')
    store = cache(path)
    assert store.get(payload()) is None
    assert store.last_status == 'unavailable'
    assert not store.put(payload(), result(), {})
    assert store.last_status == 'unavailable'
    assert capsys.readouterr() == ('', '')


def test_readers_only_see_atomic_complete_results_under_parallel_writers(tmp_path):
    initial = result()
    initial['compilerOutputs'][0]['reason'] = '完整记录initial'
    assert cache(tmp_path).put(payload(), initial, {})
    def exercise(i):
        store = cache(tmp_path)
        value = result()
        value['compilerOutputs'][0]['reason'] = f'完整记录{i}'
        written = store.put(payload(), value, {'model_calls_attempted': i})
        # Windows may refuse atomic replacement while a reader has the old file
        # open; that optimization miss must retain the previous complete record.
        if not written:
            assert store.last_status == 'unavailable'
        hit = store.get(payload())
        if hit:
            assert hit['result']['compilerOutputs'][0]['reason'].startswith('完整记录')
        else:
            assert store.last_status in {'miss', 'unavailable'}
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(exercise, range(16)))
    assert len(list(tmp_path.glob('*.json'))) == 1
    assert not list(tmp_path.glob('*.tmp'))
    assert cache(tmp_path).get(payload())['result']['compilerOutputs'][0]['reason'].startswith('完整记录')


def coverage(count=6):
    return {'status': 'sufficient', 'evidenceCount': count, 'targetMin': 6, 'targetMax': 8,
        'hasCaveat': True, 'gaps': [], 'reviewStatus': 'needs_human_review'}


def research_result():
    value = result(6)
    value['coverage'] = coverage()
    value['routeCandidates'] = [{'id': 'research-option-1', 'title': '按触感检查',
        'summary': '作者给出的检查选项', 'applicableWhen': ['有基础面团'],
        'evidenceIds': [value['compilerOutputs'][0]['evidence_cards'][0]['id']],
        'risks': ['需结合温度', 'model_inferred_needs_human_review']}]
    return value


def test_research_candidates_and_human_review_coverage_roundtrip(tmp_path):
    store = cache(tmp_path)
    value = research_result()
    assert store.put(payload(), value, {})
    assert store.get(payload())['result'] == value


@pytest.mark.parametrize('change', [
    lambda r: r['coverage'].update(evidenceCount=True),
    lambda r: r['coverage'].update(evidenceCount=5),
    lambda r: r['coverage'].update(hasCaveat=False),
    lambda r: r['coverage'].update(reviewStatus='approved'),
    lambda r: r['coverage'].update(gaps=[{'kind': 'counterevidence', 'reason': '缺少风险'}]),
    lambda r: r['coverage'].update(targetMin=3),
    lambda r: r['coverage'].update(status='insufficient'),
    lambda r: r.update(routeCandidates=[]),
    lambda r: r['routeCandidates'][0].update(risks=[]),
    lambda r: r['routeCandidates'][0].update(applicableWhen=[]),
    lambda r: r.pop('coverage'),
])
def test_coverage_cannot_promote_counts_or_human_review(tmp_path, change):
    store = cache(tmp_path)
    value = research_result()
    change(value)
    assert not store.put(payload(), value, {})


def test_coverage_source_and_author_caps_are_checked(tmp_path):
    store = cache(tmp_path)
    value = research_result()
    for item in value['compilerOutputs'][:4]:
        item['source']['author'] = '同一作者'
    assert not store.put(payload(), value, {})


def test_coverage_counts_shared_url_across_distinct_source_ids(tmp_path):
    store = cache(tmp_path)
    value = research_result()
    for item in value['compilerOutputs'][:3]:
        item['source']['url'] = 'https://www.zhihu.com/question/1/answer/99'
        item['evidence_cards'][0]['source_url'] = item['source']['url']
    assert not store.put(payload(), value, {})


@pytest.mark.parametrize('value', [True, 0, -1, float('nan'), float('inf')])
def test_invalid_ttl_is_rejected_without_raw_input(tmp_path, value):
    with pytest.raises(ValueError, match='cache_configuration_error'):
        cache(tmp_path, ttl_seconds=value)


def test_cache_identity_reuses_research_validation_and_never_stores_credentials(tmp_path):
    store = cache(tmp_path)
    p = payload()
    p['user_context']['api_key'] = 'credential-canary'
    assert store.get(p) is None
    assert not store.put(p, result(), {})
    assert not list(tmp_path.glob('*.json'))
