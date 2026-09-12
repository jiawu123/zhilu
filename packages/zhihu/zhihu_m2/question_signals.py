"""Shared, domain-neutral question and snippet structure heuristics.

These cues estimate the kind of evidence visible in a snippet. They neither
verify facts nor infer semantic support. Callers supply temporary scoring units;
source text is never modified. No profession, product or programming vocabulary
is given a relevance or detail bonus.
"""
import re


_INTENT_PATTERNS = {
    'method': r'怎样|如何|怎么|方法|步骤|\bhow\b|\b(?:steps?|methods?)\b',
    'verification': r'检验|验证|检查|判断|正确|符合|达标|\b(?:verify|verification|check|accuracy|evaluate)\b',
    'risk': r'风险|限制|局限|条件|失败|踩坑|代价|取舍|可能[^。！？?]*问题|\b(?:risks?|limitations?|caveats?|pitfalls?|failures?|trade[ -]?offs?|downsides?)\b',
    'resource': r'资源|资料|教程|书籍|推荐.*(?:工具|框架)|\b(?:resources?|tutorials?|books?|courses?)\b',
    'concept': r'什么是|是什么|为什么|为何|定义|概念|区别|组成|\bwhat (?:is|are)\b|\b(?:why|definitions?|concepts?|difference)\b',
    'experience': r'经历|经验|实践|亲身|\bexperiences?\b',
}
# Generic actions provide clues in unnumbered prose. Sequence structure below
# handles other actions without an ever-growing list of subject terminology.
_ACTIONS_ZH = ('记录', '比较', '对比', '替换', '检查', '测量', '拆分', '列出',
               '收集', '访谈', '复盘', '核对', '保存', '传入', '断言')
_ACTIONS_EN = ('record', 'compare', 'replace', 'check', 'measure', 'split', 'list',
               'collect', 'interview', 'review', 'save', 'practice', 'observe')
_VERIFY_ACTIONS = {'比较', '对比', '检查', '核对', '断言', '测量', 'compare', 'check', 'measure', 'review'}
_VERIFY_OBJECT = re.compile(r'期望|预期|标准|样例|误差|失败|结果|差异|不一致|\b(?:expected|standard|sample|error|result|difference|target)\b')
_CAPABILITY = re.compile(r'支持|号称|首选|功能|能力|\b(?:supports?|capabilities|features)\b')
_CONDITION = re.compile(r'(?:如果|除非|取决于|当).{2,}|\b(?:if|unless|when|depends? on)\s+\w.+')
_CONSEQUENCE = re.compile(r'限制|失败|漏掉|无法|不能|不适用|风险|误差|不要|延期|困难|代价|额外|\b(?:fail\w*|cannot|can\x27t|risk|error|avoid|do not|unsuitable|delay\w*|difficult|limited|additional)\b')
_CONTRAST = re.compile(r'但是|然而|而|但|\b(?:while|whereas|but)\b')
_RELATION = re.compile(r'因为|所以|因此|由于|但是|然而|而|但|\b(?:because|therefore|thus|while|whereas|but)\b')
_DEFINITION = re.compile(r'是指|指的是|定义为|区别在于|是|\b(?:means|refers to|is|are)\b')
_HEDGE = re.compile(r'可能|也许|\b(?:may|might|could)\b')
_RESOURCE_TYPE = re.compile(r'教程|资料|资源|书|框架|工具|课程|文档|\b(?:tutorial|resource|book|framework|tool|course|documentation|guide)s?\b')
_RESOURCE_USE = re.compile(r'适用|用于|支持|帮助|面向|入门|供|用来|\b(?:suitable|for beginners|designed for|helps?|used for|covers?)\b')
_NUMBER = r'(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+)'
_QUANTITY = re.compile(_NUMBER + r'\s*(?:分钟|小时|天|周|个月|次|厘米|毫米|公里|公斤|千克|米|元|页|组|个|字|段|句|%|seconds?\b|minutes?\b|hours?\b|days?\b|weeks?\b|months?\b|cm\b|mm\b|kg\b|pages?\b|words?\b|times?\b)')
_NUMBERED_STEP = re.compile(
    r'^\s*(?:(?:step|part)\s*\d+\s*[.)、:：]?\s*|'
    r'(?:步骤\s*' + _NUMBER + r'|第\s*' + _NUMBER + r'\s*步)\s*[.)、:：]?\s*|'
    r'\d+[.)、:：]\s*|[一二三四五六七八九十]+[、.)]\s*)(.+)')
_EXAMPLE = re.compile(r'(?:例如|比如|举例)[：:]?\s*[\w\u4e00-\u9fff].{3,}|\b(?:for example|for instance|such as)\b[,:]?\s+\w.+')
_NAMED_RESOURCE = re.compile(r'《[^》]{2,}》|[“\"][^”\"]{2,}[”\"]')


def detect_intents(question: str) -> tuple[str, ...]:
    """Infer requested evidence types, keeping unknown questions neutral."""
    text = question.lower()
    return tuple(name for name, pattern in _INTENT_PATTERNS.items()
                 if re.search(pattern, text)) or ('unknown',)


def _substantive(text: str) -> bool:
    """Reject punctuation, digit lists and bare sequencing filler."""
    text = re.sub(r'\b(?:first|then|next|finally|step)\b|首先|然后|最后|接着|其次', '', text)
    return bool(re.search(r'[\u4e00-\u9fff]{2,}', text) or
                len(re.findall(r'[a-z]{2,}', text)) >= 2)


def _paired_relation(unit: str, pattern: re.Pattern) -> bool:
    """Require actual content on both sides of a local connective.

    This identifies explanatory or contrastive structure, not whether its
    explanation is true or its contrast matters to the user's situation.
    """
    for local in re.split(r'[。！？!?；;]|(?<!\d)\.(?=\s|$)', unit):
        for match in pattern.finditer(local):
            sides = (local[:match.start()], local[match.end():])
            if all(_substantive(_DEFINITION.sub('', _RELATION.sub('', side))) for side in sides):
                return True
    return False


def _scoring_sentences(units: list[str]) -> list[str]:
    """Separate clear English sentence boundaries in the temporary view.

    A dot inside a URL or decimal has no following whitespace/capitalized
    sentence. A numbered step ending in a dot must also remain intact.
    """
    return [sentence for unit in units for sentence in
            re.split(r'(?<=\.)(?<!\d\.)\s+(?=[A-Z])', unit)]


def _actions(unit: str) -> set[str]:
    if _CAPABILITY.search(unit):
        return set()
    hits = set()
    for clause in re.split(r'[，,、]', unit):
        if _CAPABILITY.search(clause):
            continue
        for verb in _ACTIONS_ZH:
            if verb not in clause:
                continue
            before, _, after = clause.partition(verb)
            after = re.sub(r'^[了过着下]', '', after).strip(' 。！？!?；;:：')
            before = re.sub(r'^(?:再|先|然后|逐项|把|与|将|我|我们|并|后)+', '', before).strip()
            after = re.sub(r'^(?:一下|一番|一下子)$', '', after)
            if re.search(r'[\w\u4e00-\u9fff]', after) or len(before) >= 2:
                hits.add(verb)
        for verb in _ACTIONS_EN:
            match = re.search(r'\b' + verb + r'(?:s|d|ed|ing)?\b\s+([a-z][^,;.!?]*)', clause)
            if match and re.search(r'\b(?!the\b|a\b|an\b|it\b|this\b|that\b)[a-z]{2,}\b', match[1]):
                hits.add(verb)
    return hits


def _sequence_steps(units: list[str]) -> int:
    steps = 0
    for unit in units:
        if _CAPABILITY.search(unit):
            continue
        numbered = _NUMBERED_STEP.match(unit)
        if numbered and _substantive(numbered[1]):
            steps += 1
        sequential_parts = re.finditer(
            r'(?:^|[，,；;])\s*(?:首先|然后|最后|接着|其次|先|再|\bfirst\b|\bthen\b|\bnext\b|\bfinally\b)'
            r'[，,:：\s]*([^，,；;]+)', unit)
        for sequential in sequential_parts:
            if _substantive(sequential[1]):
                steps += 1
    return steps


def surface_scores(units: list[str]) -> dict[str, float]:
    """Score local action, condition, scope and explanation cues in [0, 1].

    A single concrete action gets a moderate score. Extra generic nouns, bare
    digits or vocabulary lists add no detail. Risk and verification cues must
    occur in the same supplied unit, never stitched across separate snippets.
    """
    views = [unit.lower() for unit in _scoring_sentences(units)]
    actions_by_unit = [_actions(unit) for unit in views]
    actions = set().union(*actions_by_unit) if views else set()
    steps = _sequence_steps(views)
    verification = any(actions & _VERIFY_ACTIONS and _VERIFY_OBJECT.search(unit)
                       for unit, actions in zip(views, actions_by_unit))
    risk = any((_CONDITION.search(unit) or (_HEDGE.search(unit) and _paired_relation(unit, _CONTRAST)))
               and _CONSEQUENCE.search(unit) for unit in views)
    resource = any((_RESOURCE_TYPE.search(unit) or _NAMED_RESOURCE.search(unit)) and _RESOURCE_USE.search(unit) for unit in views)
    concept = any(_paired_relation(unit, _DEFINITION) or _paired_relation(unit, _RELATION) or
                  re.search(r'.{2,}由.{2,}组成', unit) for unit in views)
    experience = any(re.search(r'我(?:们)?|\b(?:i|we)\b', unit) and actions and
                     re.search(r'结果|发现|误差|失败|限制|完成|无法|最后|\b(?:result|found|error|failed|completed|finally)\b', unit)
                     for unit, actions in zip(views, actions_by_unit))
    quantity = any(_QUANTITY.search(unit) and _substantive(_QUANTITY.sub('', unit)) for unit in views)
    example = any(_EXAMPLE.search(unit) for unit in views)
    named_scope = any(_NAMED_RESOURCE.search(unit) and _RESOURCE_USE.search(unit) for unit in views)
    detail = min(.25 * sum((quantity, example, named_scope, risk, verification, steps > 0)), 1.)
    return {'unknown': .5, 'method': min(.5 * max(len(actions), steps), 1.),
            'verification': float(verification), 'risk': float(risk),
            'resource': float(resource), 'concept': float(concept),
            'experience': float(experience), 'detail': detail}
