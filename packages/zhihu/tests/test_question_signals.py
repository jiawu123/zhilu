"""Domain-neutral surface regression; examples are not quality annotations."""
import pytest

from zhihu_m2.question_signals import detect_intents, surface_scores


@pytest.mark.parametrize('question,intent', [
    ('How should I practice watercolor?', 'method'),
    ('Which books can help me learn gardening?', 'resource'),
    ('How can I check pronunciation accuracy?', 'verification'),
    ('What are the limitations of this approach?', 'risk'),
    ('What is cash flow?', 'concept'),
    ('Share your experience learning guitar', 'experience'),
    ('有哪些练习摄影的资料？', 'resource'),
])
def test_question_intents_are_not_occupation_specific(question, intent):
    assert intent in detect_intents(question)


@pytest.mark.parametrize('text', [
    'API JSON HTTP Python', '1 2 3 4 5', '记录。',
    '支持测试、断言和对比。', 'First, then, next.',
])
def test_bare_terms_numbers_or_capabilities_are_not_actions_or_detail(text):
    signals = surface_scores([text])
    assert signals['method'] == signals['detail'] == 0


@pytest.mark.parametrize('text', [
    '先选取一段旋律，再慢速弹奏这一段。',
    'First sketch the outline, then shade the darker areas.',
    'First, sketch the outline, then, shade the darker areas.',
    '首先，揉好面团；然后，静置面团。',
    '1. 揉好面团', 'Step 1: measure the garden bed.',
    '记录桌腿长度，再检查接缝。',
])
def test_generic_sequences_and_action_objects_have_method_signal(text):
    assert surface_scores([text])['method'] > 0


def test_single_action_is_moderate_and_distinct_actions_are_stronger():
    assert 0 < surface_scores(['记录桌腿长度。'])['method'] <= .5
    assert surface_scores(['记录桌腿长度，比较两侧差异。'])['method'] > .5


@pytest.mark.parametrize('units,intent', [
    (['如果。', '失败后果。'], 'risk'),
    (['检查桌腿。', '期望值。'], 'verification'),
    (['If.', 'It can fail.'], 'risk'),
    (['Check the joint.', 'Expected result.'], 'verification'),
])
def test_unrelated_units_do_not_supply_local_support(units, intent):
    assert surface_scores(units)[intent] < .5


@pytest.mark.parametrize('text,intent', [
    ('如果土壤仍然湿润，就不要再次浇水。', 'risk'),
    ('If the soil is still wet, do not water it again.', 'risk'),
    ('Compare the recorded pronunciation with the expected sound.', 'verification'),
    ('《素描基础》适用于初学者，讲解明暗关系。', 'resource'),
    ('The book "Drawing Basics" is suitable for beginners.', 'resource'),
    ('Cash flow is the movement of money into and out of an account.', 'concept'),
    ('I measured the bed and found a difference in the final result.', 'experience'),
])
def test_matching_surface_signals_across_domains_and_languages(text, intent):
    assert surface_scores([text])[intent] > .5


@pytest.mark.parametrize('text', [
    '每天练习20分钟，记录节奏偏差。',
    'Practice for 20 minutes and record the mistakes.',
    '例如将每周支出分为房租与食物两项。',
    'For example, divide monthly expenses into rent and food.',
    '《花园土壤》适用于家庭种植，介绍排水检查。',
    '如果土壤仍湿，就不要再次浇水。',
    '1. 揉好面团',
])
def test_specificity_comes_from_contextual_detail(text):
    assert surface_scores([text])['detail'] > 0


def test_surface_view_is_immutable_and_scores_bounded():
    units = ['先画轮廓，再检查比例。🙂\r\n', '《素描基础》适用于新手。']
    before = units.copy()
    scores = surface_scores(units)
    assert units == before
    assert set(scores) == {'unknown', 'method', 'verification', 'risk', 'resource', 'concept', 'experience', 'detail'}
    assert all(0 <= score <= 1 for score in scores.values())
    assert scores['unknown'] == .5


def test_writing_quantity_is_contextual_detail_without_topic_bonus():
    assert surface_scores(['每天写500字初稿，连续记录一周的完成情况。'])['detail'] > 0


@pytest.mark.parametrize('units', [
    ['第一步调用 LLM API。', '第二步实现工具调用，然后测试和调试代码。'],
    ['第一步铺开画纸。', '第二步勾勒画面，然后处理亮部和暗部。'],
])
def test_spelled_numbered_steps_supply_multiple_actions(units):
    assert surface_scores(units)['method'] > .5


@pytest.mark.parametrize('units', [
    ['Part 1 用 Python 调用 LLM API。', '第2步实现 tool calling 和 JSON schema。',
     '第3步实现 Agent Loop，并加入 evaluation 和日志。'],
    ['Part 1 用铅笔绘制轮廓。', '第2步区分亮部和暗部。', '第3步加入阴影，并处理物体边缘。'],
])
def test_part_and_embedded_step_numbers_are_structural_detail(units):
    assert surface_scores(units)['detail'] > surface_scores(['坚持不懈，未来可期。'])['detail']


@pytest.mark.parametrize('question,intent', [
    ('Why does a slower shutter speed make moving cyclists look blurred?', 'concept'),
    ('为什么发酵时间会改变面包的口感？', 'concept'),
    ('选择这条路线有哪些代价和取舍？', 'risk'),
    ('每周只练习一次，可能有哪些问题？', 'risk'),
])
def test_explanation_and_tradeoff_questions_detect_evidence_kind(question, intent):
    assert intent in detect_intents(question)


@pytest.mark.parametrize('text', [
    'The exposure lasts longer, therefore a moving subject travels farther across the frame.',
    'The dough rises because the yeast releases gas.',
    '因为水分蒸发较慢，所以阴凉处的土壤保持湿润更久。',
    '布料吸水较多，而金属表面不会吸收水分。',
    'A longer exposure records more motion, whereas a shorter exposure freezes movement.',
    'The first approach costs less, but the second approach saves more time.',
])
def test_explanation_and_contrast_require_substantive_sides(text):
    assert surface_scores([text])['concept'] > .5


@pytest.mark.parametrize('text', [
    'If you only rehearse once a month, coordinating the rhythm becomes difficult.',
    'The course may save travel time, but access to live feedback remains limited.',
    '如果练习间隔过长，保持动作连贯就比较困难。',
    '这种方式可能节省材料，但返工需要额外时间。',
])
def test_condition_difficulty_and_hedged_tradeoffs_have_risk_cues(text):
    assert surface_scores([text])['risk'] > .5


@pytest.mark.parametrize('text', [
    'is are', 'because therefore whereas but', '因为。所以。但是。',
    'Whenever you practice, record the melody.',
])
def test_bare_connectives_and_routine_instructions_are_not_explanations_or_risks(text):
    scores = surface_scores([text])
    assert scores['concept'] == scores['risk'] == 0


def test_capability_sentence_does_not_erase_prior_actions():
    units = ['Compare the two sentences and record the changes. This tool supports highlighting.']
    before = units.copy()
    assert surface_scores(units)['method'] == 1
    assert units == before
    assert surface_scores(['This tool supports comparing, recording and highlighting.'])['method'] == 0


def test_sentence_scoring_preserves_url_and_decimal_tokens():
    from zhihu_m2.question_signals import _scoring_sentences
    text = 'Record 1.25 cm at https://example.com/path. This tool supports annotations.'
    assert _scoring_sentences([text]) == [
        'Record 1.25 cm at https://example.com/path.', 'This tool supports annotations.']
