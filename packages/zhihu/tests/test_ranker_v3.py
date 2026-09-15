import math
import pytest
from dataclasses import replace
from zhihu_m2.candidate_pool import SearchOccurrence, build_candidate_pool, variant_key
from zhihu_m2.ranker_v3 import RankingContext, RankedSource, detect_intents, intent_surface_score, rrf_scores, rank_candidates, select_next_source
from zhihu_m2.ranker import relevance_score
from test_candidate_pool import make_result


def pool_of(*results):
    return build_candidate_pool([SearchOccurrence(0, i+1, 't', r) for i,r in enumerate(results)])


def test_rrf_best_rank_successful_empty_query_and_empty_set():
    a,b=make_result('a'),make_result('b')
    pool=build_candidate_pool([SearchOccurrence(q,r,'t',v) for q,r,v in [(0,1,a),(0,3,a),(1,2,a),(0,2,b),(9,1,b)]])
    scores=rrf_scores(pool,{0,1,2})
    assert scores['zhihu:Article:a'] == pytest.approx((1/61+1/62)/(3/61))
    assert scores['zhihu:Article:b'] == pytest.approx((1/62)/(3/61))
    assert set(rrf_scores(pool,set()).values()) == {0.0}


@pytest.mark.parametrize('k',[True,False,0,-1,1.5,float('inf')])
def test_rrf_rejects_invalid_k(k):
    with pytest.raises(ValueError): rrf_scores([],set(),k=k)


@pytest.mark.parametrize('question,intent',[('怎样收集需求？','method'),('如何判断结果正确？','verification'),('有哪些限制？','risk'),('有什么资源？','resource'),('什么是协议？','concept'),('你实践的经历如何？','experience')])
def test_intent_detection(question,intent):
    assert intent in detect_intents(question)


def test_unknown_and_multi_intent_average():
    assert detect_intents('蓝色的天空') == ('unknown',)
    r=make_result(text='记录实际输出，再比较预期结果。')
    assert intent_surface_score(r,('unknown',)) == .5
    assert intent_surface_score(r,('method','risk')) == pytest.approx((intent_surface_score(r,('method',))+intent_surface_score(r,('risk',)))/2)


@pytest.mark.parametrize('intent,good,bad',[
 ('method','记录桌腿长度，再检查接缝。','API JSON HTTP Python'),
 ('method','访谈实际用户，收集需求。','记录。'),
 ('verification','对比实际输出与期望值。','这个框架支持测试、断言和对比。'),
 ('verification','与预期参数逐项比较。','验证测试'),
 ('risk','如果输入变化，会漏掉边界条件。','坑坑坑'),
 ('resource','这本教程适用于木工入门。','最好五分钟'),
 ('concept','协议是双方约定的规则。','API JSON HTTP'),
 ('experience','我测量桌腿后发现误差。','我整理了教程。'),
])
def test_surface_requires_local_action_object_or_matching_pattern(intent,good,bad):
    assert intent_surface_score(make_result(text=good),(intent,)) > intent_surface_score(make_result(text=bad),(intent,))


def test_distant_units_do_not_form_risk_or_verification():
    assert intent_surface_score(make_result(text='如果。失败后果。'),('risk',)) < .5
    assert intent_surface_score(make_result(text='检查桌腿。期望值。'),('verification',)) < .5


def test_later_representative_formula_and_raw_integrity():
    a=make_result(text='介绍教程。')
    b=make_result(text='记录实际参数，再比较预期参数。🙂\r\n')
    pool=build_candidate_pool([SearchOccurrence(0,1,'first',a),SearchOccurrence(1,2,'later',b)])
    ctx=RankingContext('怎样检查实际参数？',('实际参数',),False,1789171200.)
    ranked=rank_candidates(pool,ctx,{0,1})
    r=ranked[0]; c=r.components
    assert r.representative_index == 1
    assert pool[0].occurrences[1].result == b
    assert c['lexical'] == pytest.approx(.8*relevance_score(b,ctx.question)+.2*relevance_score(b,'实际参数'))
    assert c['recency'] == .5
    assert set(c) == {'lexical','rrf','intent','recency','engagement','promotion'}
    assert r.priority == pytest.approx((.45*c['lexical']+.2*c['rrf']+.25*c['intent']+.05*c['recency']+.05*c['engagement'])*(1-.5*c['promotion']))


def test_stable_representative_and_source_ties():
    pool=build_candidate_pool([SearchOccurrence(2,1,'t',make_result('b')),SearchOccurrence(0,2,'t',make_result('b')),SearchOccurrence(0,2,'t',make_result('a'))])
    ranked=rank_candidates(pool,RankingContext('',(),False,0),set())
    assert [r.source_id for r in ranked] == ['zhihu:Article:a','zhihu:Article:b']
    assert ranked[1].representative_index == 1


@pytest.mark.parametrize('fresh,edited,expected',[(False,1,.5),(True,0,.5),(True,9999999999,1.)])
def test_recency_only_when_requested(fresh,edited,expected):
    ranked=rank_candidates(pool_of(make_result(edit_time=edited)),RankingContext('',(),fresh,1789171200.),{0})
    assert ranked[0].components['recency'] == expected


@pytest.mark.parametrize('field',['vote_up_count','comment_count','edit_time','ranking_score'])
def test_nonfinite_input_rejected(field):
    with pytest.raises(ValueError):
        rank_candidates(pool_of(make_result(**{field:float('nan')})),RankingContext('',(),False,0),{0})


def test_soft_diversity_uses_only_accepted_and_score_band():
    pool=pool_of(make_result('a','记录实际输出。'),make_result('b','记录实际输出。'),make_result('c','访谈用户需求。'))
    mapping={p.source_id:p for p in pool}
    a,b,c=[RankedSource(p.source_id,0,s,{}) for p,s in zip(pool,[.85,.8,.79])]
    assert select_next_source([a,b,c],mapping,{a.source_id},set()) == b
    assert select_next_source([a,b,c],mapping,{a.source_id},{a.source_id}) == c
    low=replace(c,priority=.69)
    assert select_next_source([a,b,low],mapping,{a.source_id},{a.source_id}) == b
    assert select_next_source([a,b,c],mapping,{a.source_id,c.source_id},{a.source_id,c.source_id}) == b
    assert select_next_source([a,b,c],mapping,set(mapping),set(mapping)) is None


def test_hash_breaks_equal_representative_ties():
    a=SearchOccurrence(0,1,'a',make_result(url='a'))
    b=SearchOccurrence(0,1,'b',make_result(url='b'))
    pool=build_candidate_pool([a,b])
    ranked=rank_candidates(pool,RankingContext('',(),False,0),{0})
    assert ranked[0].representative_index == min(range(2),key=lambda i: variant_key(pool[0].occurrences[i]))


def test_diversity_uses_selected_variant_and_empty_tokens():
    pool=build_candidate_pool([SearchOccurrence(0,1,'t',make_result('a','旧文字')),
        SearchOccurrence(1,1,'t',make_result('a','记录实际输出。')),
        SearchOccurrence(0,2,'t',make_result('b','记录实际输出。')),
        SearchOccurrence(0,3,'t',make_result('c',''))])
    a,b,c=[RankedSource(p.source_id,1 if i==0 else 0,s,{}) for i,(p,s) in enumerate(zip(pool,[.9,.8,.79]))]
    assert select_next_source([a,b,c],{p.source_id:p for p in pool},{a.source_id},{a.source_id}) == c


def test_context_nonfinite_rejected():
    with pytest.raises(ValueError):
        rank_candidates([],RankingContext('',(),False,float('inf')),set())


def test_one_action_is_moderate_multiple_actions_stronger():
    one=intent_surface_score(make_result(text='记录桌腿长度。'),('method',))
    many=intent_surface_score(make_result(text='记录桌腿长度，比较两侧差异。'),('method',))
    assert 0 < one <= .5 < many <= 1


def test_all_synthetic_fixtures_preserve_sources_text_and_preferences():
    import json
    from pathlib import Path
    from zhihu_m2.models import ZhihuResult
    cases=json.loads((Path(__file__).parent/'fixtures/retrieval_v3/synthetic_cases.json').read_text(encoding='utf-8'))['cases']
    for case in cases:
        pool=build_candidate_pool([SearchOccurrence(o['query_index'],o['result_rank'],o['retrieved_at'],ZhihuResult(**o['result'])) for o in case['observations']])
        context=RankingContext(case['request']['question'],tuple(case['request']['searchQueries']),False,case['now_ts'])
        ranked=rank_candidates(pool,context,set(case['successful_query_indexes']))
        order=[r.source_id for r in ranked]
        assert len(order)==len(set(order))==len(pool)
        assert set(order)=={p.source_id for p in pool}
        for preference in case['pairwise_preferences']:
            assert order.index(preference['preferred']) < order.index(preference['other']), case['case_id']


def test_rrf_perfect_five_query_match_stays_in_unit_interval():
    pool=build_candidate_pool([SearchOccurrence(q,1,'t',make_result()) for q in range(5)])
    assert rrf_scores(pool,set(range(5)))['zhihu:Article:a'] == 1.0
    ranked=rank_candidates(pool,RankingContext('',(),False,0),set(range(5)))
    assert ranked[0].components['rrf'] == 1.0
