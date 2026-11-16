"""③ 기능 사전 매칭 - 파이썬 평가 도구
src/matcher.js와 같은 규칙을 파이썬으로 옮긴 것. src/dictionary.json의 숫자를 바꿔 가며
실험하고, labels.json(정답)으로 채점한다. 결과는 test/match-eval.mjs(JS)와 같아야 한다.
사용: python3 -I tools/evaluate.py test/data/real [--detail]
"""
import json, os, re, sys
from urllib.parse import urlsplit, urljoin

# ───────── 가중치·기준·사전: JS와 같은 src/dictionary.json을 읽는다 ─────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_CFG = json.load(open(os.path.join(_HERE, '..', 'src', 'dictionary.json'), encoding='utf-8'))
W = dict(_CFG['weights'])
DIRECT = set(_CFG['direct'])
CONFIRM = _CFG['thresholds']['confirm']
MARGIN = _CFG['thresholds']['margin']
NEAR_MAX_LEN = _CFG['thresholds']['nearMaxLen']
CONTENT_DIGITS = _CFG['thresholds']['contentDigits']
PREFIX_MIN = _CFG['thresholds']['prefixMinLen']
COMMON_MIN_ITEMS = _CFG['thresholds']['commonMinItems']
COMMON_MIN_KINDS = _CFG['thresholds']['commonMinKinds']
DICT = _CFG['functions']
SYMBOLS = _CFG['symbols']
DOMAINS = _CFG['domains']
STOP = set(_CFG['stopwords'])
IGNORED_DATA = set(_CFG.get('ignoredDataAttrs', []))   # 상태·모양만 나타내는 data- 속성 (matcher.js와 같음)

def file_stem(src):
    """그림 주소 → 확장자를 뺀 파일 이름 (data: 주소는 무시)"""
    if not src or src.startswith('data:'): return ''
    return os.path.splitext(os.path.basename(urlsplit(src).path))[0]

def split_tokens(s):
    """글자 → 토큰 목록 (kebab/snake/camel 쪼개기, 소문자, 잡음 제거)"""
    if not s: return []
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', s)          # camelCase 경계
    parts = re.split(r'[^A-Za-z0-9]+', s)
    out = []
    for p in parts:
        p = p.lower()
        if len(p) <= 2: continue                         # 한두 글자 (f, b, w, sm, lg …)
        if re.search(r'\d', p): continue                 # 숫자 섞인 조각 (48px, 해시, s1024 …)
        if p in STOP: continue
        out.append(p)
    return out

# CSS 위치 class(before:-top-px, top-0, sm:top-[3px] …)는 '맨 위로' 기능이 아니므로 빼고 자른다 (matcher.js의 classTokens와 같음)
TOP_POSITION_CLASS = re.compile(r'(?:^|:)-?top-(?:\d[\d./]*|px|auto|full|\[[^\]]+\]|\([^)]*\))!?$', re.I)

def class_tokens(value):
    return split_tokens(' '.join(n for n in (value or '').split() if not TOP_POSITION_CLASS.search(n)))

def hit(token, kw):
    return token == kw or (len(kw) >= PREFIX_MIN and token.startswith(kw))   # 5자 이상 단어만 앞부분 일치 허용

def registrable(host):
    """www.coupang.com, news.coupang.com → coupang.com (대략적인 '같은 회사' 판정)"""
    parts = host.split('.')
    if len(parts) >= 3 and parts[-2] in ('co','or','go','ac','ne') : return '.'.join(parts[-3:])
    return '.'.join(parts[-2:])

def data_values(data_attrs):
    """단서로 쓸 data- 속성 값들. 상태 속성(data-state 등)은 뺀다 (matcher.js의 dataValuesOf와 같음)"""
    return [v for k, v in (data_attrs or {}).items() if k.lower() not in IGNORED_DATA]

def data_tokens(data_attrs):
    """data- 속성 값들 → 토큰 (matcher.js의 dataTokens와 같음)"""
    return [t for v in data_values(data_attrs) for t in split_tokens(v)]

def _kind_of(c):
    """요소의 종류: 자신의 class 값을 순서·중복 없이 정리한 것 (matcher.js의 kindOf와 같음)"""
    return ' '.join(sorted(set((c.get('className') or '').split())))

def _common_words(items, words_of):
    """서로 다른 종류의 요소 여러 개에 두루 붙은 단어 (matcher.js의 commonWords와 같음)"""
    count, kinds = {}, {}
    for it in items:
        c = it['context']
        for w in set(words_of(c)):
            count[w] = count.get(w, 0) + 1
            kinds.setdefault(w, set()).add(_kind_of(c))
    return {w for w, n in count.items() if n >= COMMON_MIN_ITEMS and len(kinds[w]) >= COMMON_MIN_KINDS}

def page_common(items):
    """페이지 공통 단어 (matcher.js의 pageCommon과 같음): class 쪽과 data- 속성 쪽을 따로 센다"""
    return {
        'cls': _common_words(items, lambda c: split_tokens(c.get('id')) + class_tokens(c.get('className')) +
                             class_tokens(c.get('iconClass')) + class_tokens(c.get('parentClass'))),
        'data': _common_words(items, lambda c: data_tokens(c.get('dataAttrs'))),
    }

def _open_tag(html):
    quote = None
    for i, ch in enumerate(html):
        if quote:
            if ch == quote: quote = None
        elif ch in '"\'': quote = ch
        elif ch == '>': return html[:i + 1]
    return html

def data_attrs_from_html(html):
    """옛 수집 데이터 보정: html의 여는 태그에서 data- 속성을 뽑는다 (test/lib/html-data-attrs.mjs와 같음)"""
    out = {}
    for m in re.finditer(r'\s(data-[A-Za-z0-9_:.-]+)(?:=(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+)))?', _open_tag(html or '')):
        if len(out) >= 10: break
        v = m.group(2) if m.group(2) is not None else m.group(3) if m.group(3) is not None else m.group(4) or ''
        out[m.group(1)] = v[:50]
    return out

def with_data_attrs(items):
    return [it if 'dataAttrs' in (it.get('context') or {}) else
            {**it, 'context': {**it['context'], 'dataAttrs': data_attrs_from_html(it.get('html'))}} for it in items]

NO_COMMON = {'cls': set(), 'data': set()}

def judge(item, page_url, common=NO_COMMON):
    c = item['context']; role = item['role']
    href = (c.get('href') or '').strip()
    real_url = href and not href.startswith('#') and not href.lower().startswith('javascript:')
    url = urlsplit(urljoin(page_url, href)) if real_url else None
    page_host = urlsplit(page_url).hostname or ''

    # [0] 콘텐츠형 가려내기 (#17): 주소에 숫자가 길면 콘텐츠형 후보.
    #     요소 자신(class·id·아이콘·data-)의 단서로 [3]이 확정되면 그 기능, 아니면 콘텐츠형. 주소 단어는 쓰지 않음.
    content_like = bool(real_url and re.search(r'\d{%d,}' % CONTENT_DIGITS, href))
    if not content_like and url and url.scheme in ('http', 'https') and url.hostname:
        host = url.hostname.lower()
        # [1] F1 다른 사이트 링크
        if registrable(host) != registrable(page_host):
            for d, label in DOMAINS.items():
                if host == d or host.endswith('.' + d):
                    return ('F1', label, {})
        # [2] F2 자기 사이트 첫 화면 (지금 사이트와 완전히 같은 주소일 때만, www. 차이는 무시)
        elif host.removeprefix('www.') == page_host.removeprefix('www.') and url.path in ('', '/') and not url.query:
            return ('F2', '홈', {})

    # [3] F3 사전 매칭: 출처별 토큰 모으기
    src = {
        'path': split_tokens(url.path) if url and not content_like and registrable(url.hostname or page_host) == registrable(page_host) else [],
        'self': [t for t in split_tokens(c.get('id')) + class_tokens(c.get('className')) if t not in common['cls']],
        'icon': [t for t in class_tokens(c.get('iconClass')) if t not in common['cls']] + split_tokens(file_stem(c.get('iconSrc'))),
        'data': [t for t in data_tokens(c.get('dataAttrs')) if t not in common['data']],
    }
    name = item.get('currentName') or ''
    if item['status'] == 'meaningless' and re.search(r'\.(png|jpe?g|gif|svg|webp|ico)$', name, re.I):
        src['icon'] += split_tokens(os.path.splitext(name)[0])   # 파일명형 이름 = 아이콘 파일명
    near_texts = [t for t in (c.get('prevSiblingText'), c.get('nextSiblingText'), c.get('parentText'))
                  if t and len(t) <= NEAR_MAX_LEN]
    near_class = [t for t in class_tokens(c.get('parentClass')) if t not in common['cls']]
    dvals = data_values(c.get('dataAttrs'))

    scores = {}
    for f in DICT:
        # 역할 거름망: 페이지 안 기능(toggle)은 실제 주소가 있는 링크면 제외
        if f['kind'] == 'toggle' and role == 'link' and real_url: continue
        got = {}
        for cat in ('path', 'self', 'icon', 'data'):
            if any(hit(t, k) for t in src[cat] for k in f['tokens']): got[cat] = W[cat]
        if any(tx in v for v in dvals for tx in f['texts']): got['data'] = W['data']
        if SYMBOLS.get(name.strip()) == f['id']: got['symbol'] = W['symbol']
        if any(tx in t for t in near_texts for tx in f['texts']) or \
           any(hit(t, k) for t in near_class for k in f['tokens']): got['near'] = W['near']
        if got: scores[f['label']] = (sum(got.values()), got)
    if not scores: return ('content', None, {}) if content_like else ('AI', None, {})
    ranked = sorted(scores.items(), key=lambda kv: -kv[1][0])
    best_label, (best, got) = ranked[0]
    second = ranked[1][1][0] if len(ranked) > 1 else 0
    if best >= CONFIRM and (DIRECT & set(got)) and best - second >= MARGIN:
        return ('F3', best_label, dict(ranked))
    if content_like: return ('content', None, {})
    return ('AI', None, dict(ranked))

def main():
    d = sys.argv[1]; detail = '--detail' in sys.argv
    labs = {(o['site'], o['no']): o for o in json.load(open(os.path.join(d, 'labels.json'), encoding='utf-8'))}
    tally = {'확정 정답': 0, '확정 오답': 0, '콘텐츠 가려냄': 0, 'AI로 (정답)': 0, 'AI로 (놓침)': 0}
    rows = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith('.json') or fn == 'labels.json': continue
        site = re.sub(r'(-main)?\.json$', '', fn); data = json.load(open(os.path.join(d, fn), encoding='utf-8'))
        items = with_data_attrs(data['items'])   # 옛 데이터는 html에서 data- 속성 보충
        common = page_common(items)
        for it in items:
            how, label, cand = judge(it, data['url'], common)
            exp = labs[(site, it['no'])]['expected']
            if label:
                verdict = '확정 정답' if isinstance(exp, list) and label in exp else '확정 오답'
            elif how == 'content':
                verdict = '콘텐츠 가려냄' if exp == 'content' else 'AI로 (놓침)'
            else:
                verdict = 'AI로 (놓침)' if isinstance(exp, list) else 'AI로 (정답)'
            tally[verdict] += 1
            rows.append((site, it['no'], how, label, exp, verdict, cand))
    for k, v in tally.items(): print(f'{k:10s} {v:3d}')
    if detail:
        for r in rows:
            if r[5] != '콘텐츠 가려냄':
                cand = {k: v[0] for k, v in r[6].items()} if r[6] else ''
                print(f'{r[0]}#{r[1]:<3} {r[2]:7s} 결과={r[3]} 기대={r[4]} → {r[5]}  후보={cand}')
    return tally

if __name__ == '__main__':
    main()
