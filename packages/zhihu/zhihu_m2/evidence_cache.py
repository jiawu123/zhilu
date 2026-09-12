"""Local, bounded evidence reuse with unchanged compiler provenance.

Cache files contain evidence and a hashed request identity, never the confirmed
project context or environment. A checksum detects corruption, not a malicious
writer with local filesystem access; compiler validation is repeated on reads.
Only complete executions are reusable. An unavailable cache is a safe miss.
"""
from __future__ import annotations

from collections import Counter
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import time
from typing import Callable


CACHE_PROTOCOL = 'm2-evidence-cache-v1'
MAX_CACHE_BYTES = 2 * 1024 * 1024
_RESULT_FIELDS = {'requestId', 'status', 'compilerOutputs', 'routeCandidates',
                  'unresolvedQuestions', 'issues'}
_RECORD_FIELDS = {'protocol', 'key', 'createdAt', 'expiresAt', 'saved_search_calls',
                  'saved_model_calls', 'result', 'sha256'}


def _canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _digest(value) -> str:
    return hashlib.sha256(_canonical(value).encode('utf-8')).hexdigest()


def _text(value, maximum=2000):
    if type(value) is not str or not value.strip() or len(value) > maximum:
        raise ValueError('cache_invalid_record')


def _integer(value, maximum=10000):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('cache_invalid_record')
    return value


def _strings(value, maximum=20, maximum_text=2000):
    if type(value) is not list or len(value) > maximum:
        raise ValueError('cache_invalid_record')
    for item in value:
        _text(item, maximum_text)


def _object_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('cache_invalid_record')
        value[key] = item
    return value


def _validate_result(result, request):
    """Reuse the compiler's canonical validation rather than a second card adapter."""
    from zhihu_m2.evidence_compiler import CARD_FIELDS, validate_evidence_response
    from zhihu_m2.normalizer import normalize_result

    if (type(result) is not dict or not _RESULT_FIELDS <= set(result) or
            set(result) - _RESULT_FIELDS - {'coverage'} or
            result['requestId'] != request['id'] or result['status'] not in {'ok', 'no_evidence'} or
            result['issues'] != [] or type(result['compilerOutputs']) is not list or
            len(result['compilerOutputs']) > 50):
        raise ValueError('cache_invalid_record')
    _strings(result['unresolvedQuestions'])
    cards = {}
    sources = {}
    source_counts = Counter()
    for output in result['compilerOutputs']:
        source = output['source']
        parts = source['id'].split(':', 2)
        if len(parts) != 3 or parts[0] != 'zhihu':
            raise ValueError('cache_invalid_record')
        original = normalize_result({'ContentType': parts[1], 'ContentID': parts[2],
            'Title': source['title'], 'ContentText': source['snippet'],
            'Url': source['url'], 'AuthorName': source['author']})
        proposed = [{key: card[key] for key in CARD_FIELDS} for card in output['evidence_cards']]
        checked = validate_evidence_response({'status': output['status'], 'reason': output['reason'],
            'evidence_cards': proposed}, original, retrieved_at=source['retrievedAt'])
        # Canonical JSON also distinguishes True from 1 in quote offsets.
        if _canonical(checked) != _canonical(output):
            raise ValueError('cache_invalid_record')
        for card in output['evidence_cards']:
            source_counts[source['id']] += 1
            identity = card['id']
            if identity in cards and cards[identity] != card:
                raise ValueError('cache_invalid_record')
            cards[identity] = card
            sources[identity] = source
    if (len(cards) > request['evidenceLimit'] or
            (result['status'] == 'ok') != bool(cards)):
        raise ValueError('cache_invalid_record')
    routes = result['routeCandidates']
    if type(routes) is not list or len(routes) > 8 or (routes and 'coverage' not in result):
        raise ValueError('cache_invalid_record')
    route_ids = set()
    for route in routes:
        if type(route) is not dict or set(route) != {
                'id', 'title', 'summary', 'applicableWhen', 'evidenceIds', 'risks'}:
            raise ValueError('cache_invalid_record')
        _text(route['id'], 200)
        _text(route['title'], 300)
        _text(route['summary'], 1000)
        _strings(route['applicableWhen'], 8, 1000)
        _strings(route['evidenceIds'], 8, 200)
        _strings(route['risks'], 12, 600)
        if (route['id'] in route_ids or not route['evidenceIds'] or
                not route['applicableWhen'] or 'model_inferred_needs_human_review' not in route['risks'] or
                len(set(route['evidenceIds'])) != len(route['evidenceIds']) or
                any(identity not in cards for identity in route['evidenceIds'])):
            raise ValueError('cache_invalid_record')
        route_ids.add(route['id'])
    if 'coverage' in result:
        _validate_coverage(result['coverage'], cards, sources)
        if (any(count > 2 for count in source_counts.values()) or
                (result['coverage']['status'] == 'sufficient' and not routes)):
            raise ValueError('cache_invalid_record')


def _validate_coverage(coverage, cards, sources):
    if type(coverage) is not dict or set(coverage) != {
            'status', 'evidenceCount', 'targetMin', 'targetMax', 'hasCaveat', 'gaps', 'reviewStatus'}:
        raise ValueError('cache_invalid_record')
    for field in ('evidenceCount', 'targetMin', 'targetMax'):
        _integer(coverage[field], maximum=8)
    caveat = any(card['caveats'] for card in cards.values())
    if (coverage['status'] not in {'sufficient', 'insufficient'} or
            coverage['evidenceCount'] != len(cards) or
            coverage['targetMin'] != 6 or coverage['targetMax'] != 8 or
            type(coverage['hasCaveat']) is not bool or coverage['hasCaveat'] != caveat or
            coverage['reviewStatus'] != 'needs_human_review' or
            type(coverage['gaps']) is not list or len(coverage['gaps']) > 12):
        raise ValueError('cache_invalid_record')
    for gap in coverage['gaps']:
        if (type(gap) is not dict or set(gap) != {'kind', 'reason'} or
                gap['kind'] not in {'route', 'conditions', 'counterevidence', 'evidence_count'}):
            raise ValueError('cache_invalid_record')
        _text(gap['reason'])
    if coverage['status'] == 'sufficient' and (len(cards) < 6 or not caveat or coverage['gaps']):
        raise ValueError('cache_invalid_record')
    if coverage['status'] == 'insufficient' and not coverage['gaps']:
        raise ValueError('cache_invalid_record')
    url_counts = Counter(source['url'] for source in sources.values())
    author_counts = Counter(source['author'].strip().casefold()
                            for source in sources.values() if source['author'].strip())
    if any(count > 2 for count in url_counts.values()) or any(count > 3 for count in author_counts.values()):
        raise ValueError('cache_invalid_record')


class EvidenceCache:
    """A disposable local optimization; no logs, network, retries or environment reads.

    ``last_status`` is one of miss/hit/stored/expired/invalid/unavailable. The
    current TTL can shorten an existing record's lifetime. Changes to profile,
    compiler policy version or any research input except request.id invalidate.
    """

    def __init__(self, directory: Path, *, ttl_seconds=86400, now: Callable = time.time):
        if (type(ttl_seconds) not in (int, float) or not math.isfinite(ttl_seconds) or
                ttl_seconds <= 0 or not callable(now)):
            raise ValueError('cache_configuration_error')
        self.directory = Path(directory)
        self.ttl_seconds = ttl_seconds
        self.now = now
        self.last_status = 'miss'

    @staticmethod
    def key(payload, *, profile='batch-v1', version='m2-batch-v1') -> str:
        from zhihu_m2.research_runner import validate_research_input
        frozen = validate_research_input(payload)
        _text(profile, 80)
        _text(version, 80)
        del frozen['request']['id']
        return _digest({'profile': profile, 'version': version, 'input': frozen})

    def get(self, payload, *, profile='batch-v1', version='m2-batch-v1'):
        self.last_status = 'invalid'
        try:
            key = self.key(payload, profile=profile, version=version)
            if self.directory.exists() and not self.directory.is_dir():
                self.last_status = 'unavailable'
                return None
            with (self.directory / f'{key}.json').open('rb') as stream:
                raw = stream.read(MAX_CACHE_BYTES + 1)
            if len(raw) > MAX_CACHE_BYTES:
                return None
            record = json.loads(raw.decode('utf-8'), object_pairs_hook=_object_pairs)
            if type(record) is not dict or set(record) != _RECORD_FIELDS:
                return None
            content = {field: value for field, value in record.items() if field != 'sha256'}
            if record['protocol'] != CACHE_PROTOCOL or record['key'] != key or record['sha256'] != _digest(content):
                return None
            timestamp = self.now()
            for value in (timestamp, record['createdAt'], record['expiresAt']):
                if type(value) not in (int, float) or not math.isfinite(value):
                    return None
            if record['createdAt'] > timestamp or record['expiresAt'] <= record['createdAt']:
                return None
            if timestamp >= min(record['expiresAt'], record['createdAt'] + self.ttl_seconds):
                self.last_status = 'expired'
                return None
            for field in ('saved_search_calls', 'saved_model_calls'):
                _integer(record[field])
            result = record['result']
            _text(result['requestId'], 200)
            # External IDs are assigned by Controller; cached evidence never owns them.
            result['requestId'] = payload['request']['id']
            _validate_result(result, payload['request'])
            self.last_status = 'hit'
            return {'result': copy.deepcopy(result), 'saved_search_calls': record['saved_search_calls'],
                    'saved_model_calls': record['saved_model_calls']}
        except FileNotFoundError:
            self.last_status = 'miss'
        except OSError:
            self.last_status = 'unavailable'
        except Exception:
            # Local file content is untrusted. Do not expose paths, original errors or data.
            self.last_status = 'invalid'
        return None

    def put(self, payload, result, metrics, *, profile='batch-v1', version='m2-batch-v1') -> bool:
        self.last_status = 'invalid'
        temporary_path = None
        try:
            key = self.key(payload, profile=profile, version=version)
            frozen = copy.deepcopy(result)
            _validate_result(frozen, payload['request'])
            if type(metrics) is not dict:
                return False
            search_calls = _integer(metrics.get('search_calls_attempted', 0))
            compiler_calls = _integer(metrics.get('compiler_calls_attempted', 0))
            batch_calls = _integer(metrics.get('batch_model_calls_attempted', 0))
            model_calls = _integer(metrics.get('model_calls_attempted', compiler_calls + batch_calls))
            timestamp = self.now()
            if type(timestamp) not in (int, float) or not math.isfinite(timestamp):
                return False
            record = {'protocol': CACHE_PROTOCOL, 'key': key, 'createdAt': timestamp,
                'expiresAt': timestamp + self.ttl_seconds, 'saved_search_calls': search_calls,
                'saved_model_calls': model_calls, 'result': frozen}
            record['sha256'] = _digest(record)
            raw = _canonical(record).encode('utf-8')
            if len(raw) > MAX_CACHE_BYTES:
                return False
            self.directory.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='wb', dir=self.directory,
                    prefix=key + '.', suffix='.tmp', delete=False) as stream:
                temporary_path = Path(stream.name)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self.directory / f'{key}.json')
            self.last_status = 'stored'
            return True
        except OSError:
            self.last_status = 'unavailable'
        except Exception:
            self.last_status = 'invalid'
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass
        return False
