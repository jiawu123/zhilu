"""Trusted local retrieval configuration; never part of ResearchRequest."""
from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class RetrievalOptions:
    profile: str = 'legacy'

    def __post_init__(self):
        if type(self.profile) is not str or self.profile not in ('legacy', 'v3', 'batch-v1'):
            from zhihu_m2.research_runner import ResearchError
            raise ResearchError('configuration_error')


def options_from_env(env: Mapping[str, str]) -> RetrievalOptions:
    """Resolve only the supplied mapping, without dotenv or process I/O."""
    return RetrievalOptions(env.get('ZHIHU_RETRIEVAL_PROFILE', 'batch-v1'))
