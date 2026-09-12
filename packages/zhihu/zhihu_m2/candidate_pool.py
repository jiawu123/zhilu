"""Defensively owned raw occurrences; no retrieval, cleaning, or hard deduplication."""
import copy
import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Sequence
from zhihu_m2.models import ZhihuResult


@dataclass(frozen=True)
class SearchOccurrence:
    query_index: int
    result_rank: int
    retrieved_at: str
    result: ZhihuResult

    def __post_init__(self):
        object.__setattr__(self, 'result', copy.deepcopy(self.result))


@dataclass(frozen=True)
class SourceCandidate:
    source_id: str
    occurrences: tuple[SearchOccurrence, ...]


def build_candidate_pool(occurrences: Sequence[SearchOccurrence]) -> list[SourceCandidate]:
    """Group already validated results by type/id, preserving every occurrence."""
    groups: dict[tuple[str, str], list[SearchOccurrence]] = {}
    for occurrence in occurrences:
        result = occurrence.result
        groups.setdefault((result.content_type, result.content_id), []).append(copy.deepcopy(occurrence))
    candidates = [SourceCandidate(f'zhihu:{kind}:{cid}', tuple(items))
                  for (kind, cid), items in groups.items()]
    # Keep the shared ID encoding, but never silently merge distinct tuples if
    # malformed upstream identifiers happen to serialize to the same ID.
    if len({candidate.source_id for candidate in candidates}) != len(candidates):
        raise ValueError('ambiguous source identity')
    return candidates


def variant_key(occurrence: SearchOccurrence) -> str:
    """Hash all model fields, excluding observation metadata, without normalizing text."""
    payload = json.dumps(asdict(occurrence.result), ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()
