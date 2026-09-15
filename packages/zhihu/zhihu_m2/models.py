from dataclasses import dataclass


@dataclass
class ZhihuResult:
    """
    Normalized representation of one Zhihu search result.
    """

    title: str
    content_type: str
    content_id: str

    author_name: str
    author_signature: str
    author_badge_text: str

    content_text: str
    url: str

    vote_up_count: int
    comment_count: int

    authority_level: str
    ranking_score: float
    edit_time: int