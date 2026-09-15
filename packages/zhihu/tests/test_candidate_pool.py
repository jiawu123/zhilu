import copy
from dataclasses import fields, replace
import pytest
from zhihu_m2.models import ZhihuResult


def test_ambiguous_serialized_source_ids_fail_instead_of_overwriting():
    import pytest
    first = SearchOccurrence(0, 1, '2026-09-12T00:00:00+00:00', make_result('b', content_type='answer:a'))
    second = SearchOccurrence(0, 2, '2026-09-12T00:00:00+00:00', make_result('a:b', content_type='answer'))
    with pytest.raises(ValueError):
        build_candidate_pool([first, second])
from zhihu_m2.candidate_pool import SearchOccurrence, build_candidate_pool, variant_key


def make_result(cid='a', text='记录实际结果。', **kw):
    data = dict(title='合成样例', content_type='Article', content_id=cid,
                author_name='匿名用户', author_signature='', author_badge_text='',
                content_text=text, url=f'https://zhuanlan.zhihu.com/p/synthetic-{cid}',
                vote_up_count=0, comment_count=0, authority_level='', ranking_score=0.0, edit_time=0)
    data.update(kw)
    return ZhihuResult(**data)


def test_raw_variants_defensive_copy_at_both_boundaries():
    first = make_result(text='第一版\r\n介绍教程。')
    occurrence = SearchOccurrence(0, 1, 'first', first)
    first.content_text = '外部修改'
    assert occurrence.result.content_text == '第一版\r\n介绍教程。'
    later = SearchOccurrence(1, 2, 'later', make_result(text='第二版🙂\r\n比较实际与期望值。'))
    pool = build_candidate_pool([occurrence, later, occurrence])
    occurrence.result.content_text = '再次修改'
    assert len(pool) == 1 and len(pool[0].occurrences) == 3
    assert pool[0].occurrences[0].result.content_text == '第一版\r\n介绍教程。'
    assert pool[0].occurrences[1].retrieved_at == 'later'
    assert pool[0].occurrences[1].result.content_text == later.result.content_text


@pytest.mark.parametrize('field', [f.name for f in fields(ZhihuResult)])
def test_variant_hash_covers_every_result_field(field):
    result = make_result()
    value = getattr(result, field)
    changed = replace(result, **{field: value + 1 if isinstance(value, (int, float)) else value + 'x'})
    assert variant_key(SearchOccurrence(0, 1, 't', result)) != variant_key(SearchOccurrence(0, 1, 't', changed))


def test_hash_ignores_query_rank_time_and_preserves_duplicates():
    a = SearchOccurrence(0, 1, 't', make_result())
    b = SearchOccurrence(4, 5, 'other', make_result())
    assert variant_key(a) == variant_key(b)
    assert len(build_candidate_pool([a, a, b])[0].occurrences) == 3


def test_distinct_answers_names_signatures_urls_do_not_merge():
    results = [make_result(cid, content_type=kind, author_signature='相同签名', url='same')
               for cid, kind in [('a', 'Answer'), ('b', 'Answer'), ('a', 'Article')]]
    frozen = copy.deepcopy(results)
    pool = build_candidate_pool([SearchOccurrence(0, i+1, 't', r) for i, r in enumerate(results)])
    assert len(pool) == 3 and results == frozen
