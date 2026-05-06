require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static('.'));

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// ── 대상 기업 목록 ────────────────────────────────────────────────────────

// 국내 — 시총 상위 10 + 수주/공급계약 빈번 산업 상위 10
const DART_TARGETS = [
  // 시총 상위 10
  { corp_code: '00126380', stock_code: '005930', name: '삼성전자',       group: 'largecap' },
  { corp_code: '00164779', stock_code: '000660', name: 'SK하이닉스',     group: 'largecap' },
  { corp_code: '01515323', stock_code: '373220', name: 'LG에너지솔루션', group: 'largecap' },
  { corp_code: '00877059', stock_code: '207940', name: '삼성바이오로직스',group: 'largecap' },
  { corp_code: '00164742', stock_code: '005380', name: '현대자동차',      group: 'largecap' },
  { corp_code: '00106641', stock_code: '000270', name: '기아',            group: 'largecap' },
  { corp_code: '00413046', stock_code: '068270', name: '셀트리온',        group: 'largecap' },
  { corp_code: '00155319', stock_code: '005490', name: 'POSCO홀딩스',    group: 'largecap' },
  { corp_code: '00126362', stock_code: '006400', name: '삼성SDI',        group: 'largecap' },
  { corp_code: '00688996', stock_code: '105560', name: 'KB금융',         group: 'largecap' },
  // 수주/공급계약 빈번 산업 상위 10
  { corp_code: '00126566', stock_code: '012450', name: '한화에어로스페이스', group: 'order' },
  { corp_code: '00503668', stock_code: '079550', name: 'LIG넥스원',      group: 'order' },
  { corp_code: '00309503', stock_code: '047810', name: '한국항공우주',   group: 'order' },
  { corp_code: '01390344', stock_code: '329180', name: 'HD현대중공업',   group: 'order' },
  { corp_code: '00126478', stock_code: '010140', name: '삼성중공업',     group: 'order' },
  { corp_code: '00111704', stock_code: '042660', name: '한화오션',       group: 'order' },
  { corp_code: '00126308', stock_code: '028050', name: '삼성E&A',        group: 'order' },
  { corp_code: '00164478', stock_code: '000720', name: '현대건설',       group: 'order' },
  { corp_code: '00302926', stock_code: '064350', name: '현대로템',       group: 'order' },
  { corp_code: '00159616', stock_code: '034020', name: '두산에너빌리티', group: 'order' },
];

// 미국 — M7 + 나스닥 상위 종목
const EDGAR_TARGETS = [
  // Magnificent 7
  { cik: '0001045810', ticker: 'NVDA',  name: 'NVIDIA' },
  { cik: '0000320193', ticker: 'AAPL',  name: 'Apple' },
  { cik: '0000789019', ticker: 'MSFT',  name: 'Microsoft' },
  { cik: '0001652044', ticker: 'GOOGL', name: 'Alphabet' },
  { cik: '0001018724', ticker: 'AMZN',  name: 'Amazon' },
  { cik: '0001326801', ticker: 'META',  name: 'Meta' },
  { cik: '0001318605', ticker: 'TSLA',  name: 'Tesla' },
  // 나스닥 상위 (AI·반도체·플랫폼)
  { cik: '0001730168', ticker: 'AVGO',  name: 'Broadcom' },
  { cik: '0001065280', ticker: 'NFLX',  name: 'Netflix' },
  { cik: '0000002488', ticker: 'AMD',   name: 'AMD' },
  { cik: '0000804328', ticker: 'QCOM',  name: 'Qualcomm' },
  { cik: '0001321655', ticker: 'PLTR',  name: 'Palantir' },
  { cik: '0001729449', ticker: 'ARM',   name: 'Arm Holdings' },
  { cik: '0000050863', ticker: 'INTC',  name: 'Intel' },
  { cik: '0000723254', ticker: 'MU',    name: 'Micron' },
];

// 중요 공시 리포트명 필터 (임원지분보고 등 노이즈 제외)
const IMPORTANT_REPORT_RE = /주요사항|영업(잠정)?실적|연결재무|사업보고|반기보고|분기보고|투자결정|수주|공급계약|합병|분할|유상증자|자기주식|대표이사|최대주주|감사보고/;

// ── 응답 캐시 (30분) ─────────────────────────────────────────────────────
const cache = {};
function getCache(key) {
  const c = cache[key];
  return (c && Date.now() - c.ts < 30 * 60 * 1000) ? c.data : null;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

function fmtDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

// ── DART 공시 목록 (시총 상위 + 수주 빈번, 최근 2년) ─────────────────────
app.get('/api/filings/dart', async (req, res) => {
  if (!process.env.DART_API_KEY) return res.json({ status: 'no_key', filings: [] });

  const cached = getCache('dart');
  if (cached) return res.json({ status: 'ok', filings: cached });

  const bgn_de = fmtDate(new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000));
  const end_de = fmtDate(new Date());

  try {
    // 회사별로 병렬 요청 (200ms 간격 stagger)
    const results = await Promise.allSettled(
      DART_TARGETS.map((co, i) =>
        new Promise(resolve => setTimeout(async () => {
          try {
            const { data } = await axios.get('https://opendart.fss.or.kr/api/list.json', {
              params: {
                crtfc_key: process.env.DART_API_KEY,
                corp_code: co.corp_code,
                bgn_de,
                end_de,
                page_count: 100,
                sort: 'date',
                sort_mth: 'desc',
              },
              timeout: 12000,
            });
            resolve((data.list || []).map(f => ({ ...f, _group: co.group })));
          } catch (e) {
            console.warn(`DART 조회 실패 (${co.name}):`, e.message.slice(0, 60));
            resolve([]);
          }
        }, i * 200))
      )
    );

    const all = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(f => IMPORTANT_REPORT_RE.test(f.report_nm));

    // 날짜 내림차순 정렬
    all.sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt) || b.rcept_no.localeCompare(a.rcept_no));

    const filings = all.map(f => ({
      id: f.rcept_no,
      source: 'dart',
      company: f.corp_name,
      ticker: f.stock_code,
      market: f.corp_cls === 'K' ? 'KOSDAQ' : 'KOSPI',
      title: f.report_nm,
      date: f.rcept_dt,
      time: '',
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${f.rcept_no}`,
      group: f._group,
    }));

    setCache('dart', filings);
    res.json({ status: 'ok', filings });
  } catch (err) {
    console.error('DART 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EDGAR 공시 목록 (M7 + 나스닥 상위, 최근 2년) ─────────────────────────
app.get('/api/filings/edgar', async (req, res) => {
  const cached = getCache('edgar');
  if (cached) return res.json({ status: 'ok', filings: cached });

  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);

  // 8-K item → 한국어 설명
  const ITEM_LABELS = {
    '1.01': '중요계약 체결', '1.02': '중요계약 해지', '1.05': '사이버보안 사고',
    '2.01': '자산 취득·처분', '2.02': '영업실적 발표', '2.03': '직접금융',
    '2.05': '직원 감원', '2.06': '자산 손상',
    '3.01': '상장폐지 통보', '3.02': '미등록 주식 판매',
    '4.01': '감사인 변경', '4.02': '재무제표 재작성',
    '5.01': '임원 보상 변경', '5.02': '임원 취임·사임',
    '7.01': 'Reg FD 공시', '8.01': '기타 주요 사항', '9.01': '재무제표 첨부',
  };

  try {
    const results = await Promise.allSettled(
      EDGAR_TARGETS.map((co, i) =>
        new Promise(resolve => setTimeout(async () => {
          try {
            const { data } = await axios.get(
              `https://data.sec.gov/submissions/CIK${co.cik}.json`,
              {
                headers: { 'User-Agent': 'Context.ai info@disclosai.kr' },
                timeout: 12000,
              }
            );

            const recent = data.filings?.recent || {};
            const forms       = recent.form            || [];
            const dates       = recent.filingDate      || [];
            const accessions  = recent.accessionNumber || [];
            const items       = recent.items           || [];
            const primaryDocs = recent.primaryDocument || [];

            const entries = [];
            for (let idx = 0; idx < forms.length; idx++) {
              if (!['8-K', '10-K', '10-Q'].includes(forms[idx])) continue;
              if (new Date(dates[idx]) < twoYearsAgo) break; // 날짜 내림차순이므로 조기 종료

              const itemStr = items[idx] || '';
              const itemCodes = itemStr.split(',').map(s => s.trim()).filter(Boolean);
              const itemDesc = itemCodes.map(c => ITEM_LABELS[c] || c).filter(Boolean).join(' / ') || '';

              const formLabel = forms[idx] === '10-K' ? '연간 실적보고서'
                              : forms[idx] === '10-Q' ? '분기 실적보고서'
                              : itemDesc || '주요 공시';

              const accFmt = accessions[idx]?.replace(/-/g, '') || '';
              const docUrl = accFmt
                ? `https://www.sec.gov/Archives/edgar/data/${parseInt(co.cik)}/${accFmt}/${primaryDocs[idx] || ''}`
                : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${co.cik}&type=${forms[idx]}`;

              entries.push({
                id: `edgar-${co.ticker}-${accessions[idx]}`,
                source: 'edgar',
                company: co.name,
                ticker: co.ticker,
                market: 'NYSE/NASDAQ',
                title: `[${forms[idx]}] ${co.name} — ${formLabel}`,
                date: dates[idx],
                time: '',
                url: docUrl,
                formType: forms[idx],
                items: itemDesc,
              });
            }
            resolve(entries);
          } catch (e) {
            console.warn(`EDGAR 조회 실패 (${co.name}):`, e.message.slice(0, 60));
            resolve([]);
          }
        }, i * 300))
      )
    );

    const all = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => b.date.localeCompare(a.date));

    setCache('edgar', all);
    res.json({ status: 'ok', filings: all });
  } catch (err) {
    console.error('EDGAR 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 원문 텍스트 추출 헬퍼 ─────────────────────────────────────────────────
const AdmZip = require('adm-zip');

// DART HTML에서 한국어 재무 테이블 추출
function extractFinancialTablesFromHtmlKR(html, maxLen = 6000) {
  if (!html) return null;
  const FINANCIAL_RE = /매출|영업이익|당기순이익|영업수익|손익|재무/;
  const HAS_NUMBERS_RE = /[\d,]{4,}/;

  function cellText(cellHtml) {
    return cellHtml
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }
  function tableToText(tableHtml) {
    const rows = [];
    for (const rowM of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [];
      for (const cellM of rowM[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        const t = cellText(cellM[1]);
        if (t) cells.push(t);
      }
      if (cells.length > 0) rows.push(cells.join('  |  '));
    }
    return rows.join('\n');
  }

  const results = [];
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const tableHtml = m[0];
    if (!FINANCIAL_RE.test(tableHtml)) continue;
    const text = tableToText(tableHtml);
    if (text.length < 100 || !HAS_NUMBERS_RE.test(text)) continue;
    results.push(text);
    if (results.join('\n\n').length > maxLen) break;
  }
  if (results.length === 0) return null;
  return results.join('\n\n---\n\n').slice(0, maxLen);
}

// DART 문서 텍스트에서 핵심 재무 수치 추출 (매출·영업이익·순이익 + YoY)
function parseDartFinancials(text) {
  if (!text) return null;

  // 단위 파악 (기본: 백만원)
  let scale = 1; // 결과를 백만원 단위로 통일
  if (/단위\s*[:：]\s*천\s*원/.test(text))       scale = 0.001;
  else if (/단위\s*[:：]\s*억\s*원/.test(text))  scale = 100;
  else if (/단위\s*[:：]\s*원(?!\s*미만)/.test(text) && !/백만/.test(text)) scale = 0.000001;
  // 백만원이면 scale = 1 그대로

  const parseNum = (s) => {
    if (!s) return null;
    // △ 또는 (숫자) 형식은 음수
    let neg = false;
    if (/^△/.test(s.trim()) || /^\([\d,]+\)$/.test(s.trim())) neg = true;
    const n = parseFloat(s.replace(/[△(),]/g, '').replace(/,/g, '').trim());
    return isNaN(n) ? null : (neg ? -n : n) * scale;
  };

  // 항목 | 당기 숫자 | 전기 숫자 패턴 (파이프 구분 또는 공백 구분 모두 허용)
  const findMetric = (patterns) => {
    for (const pat of patterns) {
      const re = new RegExp(
        pat + '[\\s│\\|]*([△(]?[\\d,]+[)]?)' +
        '(?:[\\s│\\|]+([△(]?[\\d,]+[)]?))?',
        'i'
      );
      const m = re.exec(text);
      if (m) return { cur: parseNum(m[1]), prev: parseNum(m[2]) || null };
    }
    return null;
  };

  const rev  = findMetric(['매출액', '영업수익', '수익\\s*\\(매출액\\)']);
  const op   = findMetric(['영업이익']);
  const ni   = findMetric(['당기순이익(?!\\s*\\()']);

  if (!rev && !op && !ni) return null;

  const fmt = (n) => {
    if (n == null) return null;
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}조원`;
    if (abs >= 10000)   return `${sign}${(abs / 10000).toFixed(0)}억원`;
    return `${sign}${Math.round(abs)}백만원`;
  };

  const yoy = (cur, prev) => {
    if (cur == null || prev == null || prev === 0) return '';
    const r = Math.round((cur - prev) / Math.abs(prev) * 1000) / 10;
    return ` (YoY ${r > 0 ? '+' : ''}${r}%)`;
  };

  const parts = [];
  if (rev?.cur  != null) parts.push(`매출액 ${fmt(rev.cur)}${yoy(rev.cur, rev.prev)}`);
  if (op?.cur   != null) parts.push(`영업이익 ${fmt(op.cur)}${yoy(op.cur, op.prev)}`);
  if (ni?.cur   != null) parts.push(`당기순이익 ${fmt(ni.cur)}${yoy(ni.cur, ni.prev)}`);

  return parts.length > 0 ? `[실제 데이터] ${parts.join(' / ')}` : null;
}

async function fetchDartDocText(rcept_no, corp_code = null, filing_date = null) {
  try {
    const { data } = await axios.get('https://opendart.fss.or.kr/api/document.xml', {
      params: { crtfc_key: process.env.DART_API_KEY, rcept_no },
      responseType: 'arraybuffer',
      timeout: 15000,
    });

    // DART가 ZIP 대신 XML 에러(status 014 등)를 반환하는 경우 처리
    const raw = Buffer.from(data);
    if (raw.slice(0, 5).toString().includes('<?xml') || raw.slice(0, 5).toString().includes('<resu')) {
      const xmlStr = raw.toString('utf8');
      const statusMatch = xmlStr.match(/<status>(\d+)<\/status>/);
      if (statusMatch && statusMatch[1] !== '000') {
        console.warn(`DART document.xml status ${statusMatch[1]} — structured API fallback 시도`);
        return corp_code ? await fetchDartStructuredFallback(corp_code, rcept_no, filing_date) : null;
      }
    }

    const zip = new AdmZip(raw);
    const entries = zip.getEntries().sort((a, b) => b.header.size - a.header.size);
    const entry = entries.find(e => /\.(html?|xml)$/i.test(e.entryName));
    if (!entry) return null;

    const rawHtml = entry.getData().toString('utf8')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    // 재무 테이블 우선 추출 (구조화된 수치 보존)
    const tableText = extractFinancialTablesFromHtmlKR(rawHtml);
    if (tableText && tableText.length > 300) return tableText;

    // fallback: 일반 텍스트
    const text = rawHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
    return text.slice(0, 8000);
  } catch (e) {
    console.warn('DART 원문 조회 실패:', e.message.slice(0, 60));
    if (corp_code) return fetchDartStructuredFallback(corp_code, rcept_no, filing_date);
    return null;
  }
}

// DART document.xml이 파일 없음(014)을 반환할 때 구조화 API로 대체 텍스트 생성
async function fetchDartStructuredFallback(corp_code, rcept_no, filing_date) {
  try {
    const year = (filing_date || '').slice(0, 4) || String(new Date().getFullYear());

    // 최대주주·주요주주 변동 데이터
    const { data: ms } = await axios.get('https://opendart.fss.or.kr/api/majorstock.json', {
      params: { crtfc_key: process.env.DART_API_KEY, corp_code, bsns_year: year, reprt_code: '11011' },
      timeout: 10000,
    });
    if (ms.status === '000' && ms.list?.length) {
      // 해당 rcept_no와 날짜 근처의 항목 우선, 없으면 전체 최근 5건
      const items = ms.list
        .filter(i => i.rcept_no <= rcept_no)
        .sort((a, b) => b.rcept_no.localeCompare(a.rcept_no))
        .slice(0, 5);

      if (items.length) {
        const lines = items.map(i => {
          const changed = i.stkqy_irds && i.stkqy_irds !== '-'
            ? ` (변동 ${i.stkqy_irds}주, ${i.stkrt_irds}%p)`
            : '';
          return `${i.repror}: 보유 ${i.stkqy}주 (${i.stkrt}%)${changed} — ${i.report_resn}`;
        });
        return `[주요주주 보유현황 — OpenDART 구조화 데이터]\n${lines.join('\n')}`;
      }
    }
  } catch (e) {
    console.warn('DART structured fallback 실패:', e.message.slice(0, 60));
  }
  return null;
}

const EDGAR_HEADERS = { 'User-Agent': 'Context.ai info@disclosai.kr' };

function stripHtmlText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

// HTML에서 재무 테이블을 추출해 읽기 쉬운 텍스트로 변환
function extractFinancialTablesFromHtml(html, maxLen = 6000) {
  if (!html) return null;
  const FINANCIAL_RE = /revenue|income|earnings|profit|loss|operating|total|quarter|fiscal|diluted|eps|\$\s*\d/i;
  const HAS_NUMBERS_RE = /\$?\s*\d[\d,]+/;

  function cellText(cellHtml) {
    return cellHtml
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }

  function tableToText(tableHtml) {
    const rows = [];
    for (const rowM of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [];
      for (const cellM of rowM[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        const t = cellText(cellM[1]);
        if (t) cells.push(t);
      }
      if (cells.length > 0) rows.push(cells.join('  |  '));
    }
    return rows.join('\n');
  }

  const results = [];
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const tableHtml = m[0];
    if (!FINANCIAL_RE.test(tableHtml)) continue;
    const text = tableToText(tableHtml);
    if (text.length < 100 || !HAS_NUMBERS_RE.test(text)) continue;
    results.push(text);
    if (results.join('\n\n').length > maxLen) break;
  }
  if (results.length === 0) return null;
  return results.join('\n\n---\n\n').slice(0, maxLen);
}

async function fetchEdgarDocText(primaryUrl, formType = '') {
  const dirMatch = primaryUrl.match(/(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/(\d+)\/)/);
  const dirUrl  = dirMatch?.[1];
  const accFlat = dirMatch?.[2];

  // ── 1단계: primary document 가져오기 ─────────────────────────────────────
  let primaryHtml = '', primaryText = '';
  const isDirectoryUrl = !primaryUrl.split('/').pop().includes('.');
  if (!isDirectoryUrl) {
    try {
      const { data } = await axios.get(primaryUrl, { headers: EDGAR_HEADERS, timeout: 12000 });
      primaryHtml = data;
      primaryText = stripHtmlText(data);
    } catch (e) {
      console.warn('[EDGAR] primary fetch 실패:', e.message.slice(0, 60));
    }
  }

  // iXBRL 감지: XBRL namespace 포함 → 8-K에서만 wrapper로 처리
  // 10-Q/10-K iXBRL은 문서 자체가 내용이므로 직접 파싱
  const isIXBRL = /xmlns:ix\s*=|<ix:header/i.test(primaryHtml);
  const isPeriodicReport = /^10-[QK]$/.test(formType);
  const referencesExhibit99 = /exhibit\s*99/i.test(primaryText);
  const hasFinancialData = /\$[\s\d,]+(?:billion|million)?|\d+\.?\d*\s*(?:billion|million)[\s,]|\d+\.\d+\s*%/i.test(primaryText);
  const isWrapper = isDirectoryUrl
    || (isIXBRL && !isPeriodicReport)
    || (!isIXBRL && referencesExhibit99 && !hasFinancialData);


  if (!isWrapper && primaryText.length > 400) {
    // 테이블 우선 추출: 재무 테이블이 있으면 구조화된 수치 데이터 반환
    const tableText = extractFinancialTablesFromHtml(primaryHtml);
    if (tableText && tableText.length > 300) return tableText;
    // fallback: 텍스트 기반 섹션 추출
    if (isPeriodicReport) return extractFinancialSection(primaryText);
    return primaryText.slice(0, 8000);
  }

  // ── 2단계: filing index HTML로 EX-99.1 링크 직접 추출 ────────────────────
  if (dirUrl && accFlat) {
    const accFormatted = accFlat.replace(/^(\d{10})(\d{2})(\d{6})$/, '$1-$2-$3');
    const indexUrl = `${dirUrl}${accFormatted}-index.htm`;
    try {
      const { data: indexHtml } = await axios.get(indexUrl, { headers: EDGAR_HEADERS, timeout: 8000 });
      // index HTML 테이블에서 EX-99.1 행의 href 추출
      const exMatch = indexHtml.match(/EX-99\.1[\s\S]{0,300}?href="(\/Archives\/edgar\/data\/[^"]+)"/i)
                   || indexHtml.match(/href="(\/Archives\/edgar\/data\/[^"]+)"[\s\S]{0,300}?EX-99\.1/i);
      const exhibitUrl = exMatch ? 'https://www.sec.gov' + exMatch[1] : null;
      if (exhibitUrl) {
        const { data: exHtml } = await axios.get(exhibitUrl, { headers: EDGAR_HEADERS, timeout: 12000 });
        const tableText = extractFinancialTablesFromHtml(exHtml);
        if (tableText && tableText.length > 300) return tableText;
        const exText = stripHtmlText(exHtml);
        if (exText.length > 400) return exText.slice(0, 8000);
      }
    } catch (e) {
      console.warn('[EDGAR] index htm 조회 실패:', e.message.slice(0, 60));
    }
  }

  // ── 3단계: fallback — 디렉토리 스캔 ─────────────────────────────────────
  if (!dirUrl) return null;
  try {
    const { data: dirHtml } = await axios.get(dirUrl, { headers: EDGAR_HEADERS, timeout: 10000 });
    const docLinks = [...dirHtml.matchAll(/href="(\/Archives\/edgar\/data\/[^"]+\.htm)"/gi)]
      .map(m => 'https://www.sec.gov' + m[1])
      .filter(u => u.startsWith(dirUrl) && !u.includes('index') && !u.includes('_htm.xml') && u !== primaryUrl);

    let bestTables = '', bestText = '';
    for (const docUrl of docLinks.slice(0, 5)) {
      try {
        const { data } = await axios.get(docUrl, { headers: EDGAR_HEADERS, timeout: 12000 });
        const tableText = extractFinancialTablesFromHtml(data);
        if (tableText && tableText.length > (bestTables.length)) bestTables = tableText;
        if (!tableText) {
          const text = stripHtmlText(data);
          if (text.length > bestText.length) bestText = text;
        }
        if (bestTables.length > 2000) break;
      } catch { continue; }
    }
    if (bestTables.length > 300) return bestTables;
    return bestText.slice(0, 8000) || null;
  } catch {
    return null;
  }
}

// 재무 관련 핵심 섹션 추출 (10-Q/10-K 등 대용량 문서 처리)
function extractFinancialSection(text, maxLen = 5000) {
  if (!text) return null;

  // TOC-style entry: marker followed shortly by a bare page number (e.g. "31\n")
  function isTocEntry(text, idx, markerLen) {
    const after = text.slice(idx + markerLen, idx + markerLen + 50).replace(/&#\d+;/g, ' ');
    return /^[\s,."]{0,20}\d{1,3}\s*\n/.test(after);
  }

  // Phase 1: high-value section headers — skip TOC entries, take first real one
  const sectionMarkers = [
    'Results of Operations', 'RESULTS OF OPERATIONS',
    'Financial Results', 'FINANCIAL RESULTS',
    'Financial Highlights', 'FINANCIAL HIGHLIGHTS',
    'Highlights from', 'HIGHLIGHTS FROM',
    'Operating highlights', 'OPERATING HIGHLIGHTS',
  ];
  let bestIdx = -1;
  for (const marker of sectionMarkers) {
    let pos = 0;
    while (true) {
      const idx = text.indexOf(marker, pos);
      if (idx === -1) break;
      if (!isTocEntry(text, idx, marker.length)) {
        if (bestIdx === -1 || idx < bestIdx) bestIdx = idx;
        break;
      }
      pos = idx + marker.length;
    }
  }
  if (bestIdx > 0) return text.slice(Math.max(0, bestIdx - 200), bestIdx + maxLen);

  // Phase 2: inline data markers (these rarely appear in TOC)
  const dataMarkers = [
    'Revenue was', 'Revenue increased', 'Revenue decreased',
    'Revenues were', 'Net revenues', 'NET REVENUES',
    'Total revenue', 'TOTAL REVENUE',
    'Three Months Ended', 'THREE MONTHS ENDED',
    'Quarter Ended', 'QUARTER ENDED',
  ];
  for (const marker of dataMarkers) {
    const idx = text.indexOf(marker);
    if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx > 0) return text.slice(Math.max(0, bestIdx - 200), bestIdx + maxLen);

  return text.slice(0, maxLen);
}


// ── 5대 주가 예측 변수 계산 ───────────────────────────────────────────────

// FMP 캐시 (ticker별, 1시간 TTL) — 무료 티어 429 방지
const _fmpCache = new Map();
const FMP_CACHE_TTL = 60 * 60 * 1000; // 1시간

// 1. NLP 감성 점수 (로컬 계산)
// 0. FMP 컨센서스 + CAPEX + 밸류에이션 + 성장 둔화 (미국 주식 전용)
async function fetchFmpData(ticker, filingDate) {
  const key = process.env.FMP_API_KEY;
  if (!key || !ticker) return null;

  // 캐시 확인 (ticker 단위로 캐시 — 같은 종목 여러 공시 분석 시 재사용)
  const cacheKey = ticker.toUpperCase();
  const cached = _fmpCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FMP_CACHE_TTL) {
    return cached.data;
  }

  try {
    // ratios-ttm 호출 제거 — P/E는 Twelve Data 주가 + FMP EPS로 직접 계산 (API 호출 3→ 절약)
    const [earningsRes, cashflowRes, incomeRes] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/stable/earnings?symbol=${ticker}&apikey=${key}`, { timeout: 8000 }),
      axios.get(`https://financialmodelingprep.com/stable/cash-flow-statement?symbol=${ticker}&period=quarter&limit=5&apikey=${key}`, { timeout: 8000 }),
      axios.get(`https://financialmodelingprep.com/stable/income-statement?symbol=${ticker}&period=quarter&limit=5&apikey=${key}`, { timeout: 8000 }),
    ]);

    // 1. 어닝 서프라이즈
    const earnings = (earningsRes.data || []).filter(e => e.epsActual != null && e.date <= filingDate);
    const latest = earnings[0] || null;
    let consensusLine = null;
    if (latest) {
      const epsSurprise = latest.epsEstimated
        ? Math.round((latest.epsActual - latest.epsEstimated) / Math.abs(latest.epsEstimated) * 1000) / 10
        : null;
      const revSurprise = latest.revenueEstimated && latest.revenueActual
        ? Math.round((latest.revenueActual - latest.revenueEstimated) / latest.revenueEstimated * 1000) / 10
        : null;
      const fmt = (n) => n > 0 ? `+${n}%` : `${n}%`;
      const parts = [];
      if (epsSurprise != null) parts.push(`EPS 실제 $${latest.epsActual} vs 컨센서스 $${latest.epsEstimated} (${fmt(epsSurprise)})`);
      if (revSurprise != null) {
        const revB = (v) => `$${(v/1e9).toFixed(1)}B`;
        parts.push(`매출 실제 ${revB(latest.revenueActual)} vs 컨센서스 ${revB(latest.revenueEstimated)} (${fmt(revSurprise)})`);
      }
      if (parts.length) consensusLine = parts.join(' / ');
    }

    // 2. CAPEX 효율성
    const cashflows = cashflowRes.data || [];
    const incomes = incomeRes.data || [];
    let capexLine = null;
    if (cashflows.length >= 2) {
      const cur = cashflows[0], prev = cashflows[1];
      const capexCur  = Math.abs(cur.capitalExpenditure  || 0);
      const capexPrev = Math.abs(prev.capitalExpenditure || 0);
      const revCur  = incomes[0]?.revenue || 0;
      const capexGrowth = capexPrev > 0 ? Math.round((capexCur - capexPrev) / capexPrev * 1000) / 10 : null;
      const capexRatio  = revCur > 0 ? Math.round(capexCur / revCur * 1000) / 10 : null;
      const fmtB = (v) => `$${(v/1e9).toFixed(2)}B`;
      if (capexGrowth != null) {
        capexLine = `CAPEX ${fmtB(capexCur)} (전분기 대비 ${capexGrowth > 0 ? '+' : ''}${capexGrowth}%)`;
        if (capexRatio != null) capexLine += `, 매출 대비 ${capexRatio}%`;
      }
    }

    // 3. TTM EPS 계산 (최근 4분기 합산) — P/E 계산에 사용
    const allEarnings = earningsRes.data || [];
    const last4 = allEarnings.filter(e => e.epsActual != null).slice(0, 4);
    const ttmEps = last4.length === 4 ? last4.reduce((s, e) => s + e.epsActual, 0) : null;

    // 4. 매출 성장률 둔화 감지 (최근 3~4분기 YoY 성장률 추이)
    let growthLine = null;
    if (incomes.length >= 4) {
      // QoQ 성장률 계산 (최근 3분기)
      const growthRates = [];
      for (let i = 0; i < Math.min(3, incomes.length - 1); i++) {
        const cur  = incomes[i]?.revenue;
        const prev = incomes[i + 1]?.revenue;
        if (cur && prev && prev > 0) {
          growthRates.push(Math.round((cur - prev) / prev * 1000) / 10);
        }
      }
      if (growthRates.length >= 2) {
        const trend = growthRates[0] - growthRates[growthRates.length - 1]; // 최신 - 가장 오래된
        const rateStr = growthRates.map(r => `${r > 0 ? '+' : ''}${r}%`).join(' → ');
        if (trend < -3) {
          growthLine = `매출 성장률 둔화: QoQ ${rateStr} — 성장 모멘텀 약화 중`;
        } else if (trend > 3) {
          growthLine = `매출 성장률 가속: QoQ ${rateStr} — 성장 모멘텀 강화`;
        } else {
          growthLine = `매출 성장률 안정: QoQ ${rateStr}`;
        }
      }
    }

    const result = { consensusLine, capexLine, ttmEps, growthLine };
    _fmpCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    console.warn('FMP 조회 실패:', e.message.slice(0, 60));
    // 429 등 일시적 오류 → 이전 캐시 반환
    const stale = _fmpCache.get(cacheKey);
    if (stale) { console.log('[FMP] 캐시 폴백 사용:', cacheKey); return stale.data; }
    return null;
  }
}

// 0-b. 공시 전 30일 주가 모멘텀
async function fetchMomentum30(ticker, market, filingDate) {
  try {
    const isKorean = market === 'KOSPI' || market === 'KOSDAQ' || market === 'kr';
    const filing = new Date(filingDate + 'T00:00:00Z');
    const from   = new Date(filing.getTime() - 40 * 86400000).toISOString().slice(0, 10);

    let prices = [];
    if (isKorean) {
      // 국내 주식: 네이버 차트
      const all = await fetchNaverChart(ticker, 100);
      prices = all.filter(p => p.date >= from && p.date <= filingDate);
    } else {
      // 미국 주식: FMP 주가 히스토리 (Twelve Data 대체)
      if (!process.env.FMP_API_KEY) return null;
      const { data } = await axios.get(
        `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}`, {
        params: { from, to: filingDate, apikey: process.env.FMP_API_KEY },
        timeout: 10000,
      });
      if (!data?.historical?.length) return null;
      prices = data.historical
        .filter(v => v.date >= from && v.date <= filingDate)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(v => ({ date: v.date, close: v.close }));
    }

    if (prices.length < 5) return null;
    const first = prices[0].close;
    const last  = prices[prices.length - 1].close;
    const ret30 = Math.round((last - first) / first * 1000) / 10;

    let signal = 'neutral';
    let comment = '';
    if (ret30 >= 20) { signal = 'warning'; comment = `⚠️ 공시 전 30일 +${ret30}% 급등 — 기대감 이미 상당 부분 반영, 실망 매물 위험`; }
    else if (ret30 >= 10) { signal = 'caution'; comment = `주의: 공시 전 30일 +${ret30}% — 일부 기대감 선반영`; }
    else if (ret30 <= -10) { signal = 'positive'; comment = `공시 전 30일 ${ret30}% 하락 — 낮아진 기대치로 서프라이즈 여지`; }
    else { comment = `공시 전 30일 수익률 ${ret30 > 0 ? '+' : ''}${ret30}% — 중립적 모멘텀`; }

    return { ret30, signal, comment, lastPrice: last };
  } catch (e) {
    console.warn('모멘텀 조회 실패:', e.message.slice(0, 60));
    return null;
  }
}

function computeNlpSentiment(text) {
  if (!text) return null;
  const NEG = ['uncertain','uncertainty','challenge','challenging','risk','headwind',
    'difficult','difficulty','decline','declining','concern','concerning','disappointing',
    'disappoint','weak','weakness','slowdown','downturn','adverse','unfavorable',
    'pressure','volatile','volatility','disruption','deteriorat','miss','missed',
    'below expectations','shortfall','loss','losses','warn','caution','macro pressure'];
  const POS = ['growth','growing','exceed','exceeded','record','strong','outperform',
    'momentum','accelerat','expand','beat','beats','robust','solid','surge','raised',
    'increase','improved','improving','ahead','guidance raised','ahead of','upside'];
  const lower = text.toLowerCase();
  const wordCount = lower.split(/\W+/).filter(w => w.length > 2).length || 1;
  const negCount = NEG.reduce((n, w) => n + (lower.split(w).length - 1), 0);
  const posCount = POS.reduce((n, w) => n + (lower.split(w).length - 1), 0);
  const negRate  = parseFloat((negCount / wordCount * 1000).toFixed(1));
  const posRate  = parseFloat((posCount / wordCount * 1000).toFixed(1));
  const signal   = posCount > negCount * 1.5 ? 'positive'
                 : negCount > posCount * 1.5 ? 'negative' : 'neutral';
  return { negCount, posCount, negRate, posRate, signal };
}

// 2. 매크로 컨텍스트 (FRED API — VIX + 10년물 금리, 키 불필요)
async function fetchMacroContext(date) {
  try {
    const getLatestBefore = async (seriesId) => {
      const { data } = await axios.get(
        `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000, responseType: 'text' }
      );
      const lines = data.trim().split('\n').slice(1); // 헤더 제거
      // date 이하의 가장 가까운 값 찾기
      const target = date.replace(/-/g, '-');
      let val = null;
      for (const line of lines) {
        const [d, v] = line.split(',');
        if (d <= target && v && v.trim() !== '.') val = parseFloat(v);
      }
      return val;
    };
    const [vix, tnx] = await Promise.all([
      getLatestBefore('VIXCLS'),
      getLatestBefore('DGS10'),
    ]);
    const vixSignal = !vix ? 'neutral' : vix > 25 ? 'negative' : vix < 15 ? 'positive' : 'neutral';
    const tnxSignal = !tnx ? 'neutral' : tnx > 4.5 ? 'negative' : tnx < 3.5 ? 'positive' : 'neutral';
    return { vix, tnx, vixSignal, tnxSignal };
  } catch { return { vix: null, tnx: null, vixSignal: 'neutral', tnxSignal: 'neutral' }; }
}

// 2-b. 한국 매크로 (원/달러 환율 — FRED DEXKOUS, 키 불필요)
async function fetchKoreanMacro(date) {
  try {
    const { data } = await axios.get(
      'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXKOUS',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000, responseType: 'text' }
    );
    const lines = data.trim().split('\n').slice(1);
    let usdkrw = null;
    for (const line of lines) {
      const [d, v] = line.split(',');
      if (d <= date && v && v.trim() !== '.') usdkrw = parseFloat(v);
    }
    if (!usdkrw) return null;

    let comment;
    if      (usdkrw >= 1450) comment = `⚠️ 원/달러 ${Math.round(usdkrw)}원 — 극단적 강달러: 수입원가 급등, 수출기업 환차익`;
    else if (usdkrw >= 1350) comment = `원/달러 ${Math.round(usdkrw)}원 — 강달러: 수출기업 우호적, 내수·원자재 기업 비용 부담`;
    else if (usdkrw <= 1150) comment = `원/달러 ${Math.round(usdkrw)}원 — 원화 강세: 수출기업 환차손 가능성`;
    else                      comment = `원/달러 ${Math.round(usdkrw)}원 — 환율 안정 구간`;

    return { usdkrw, comment };
  } catch (e) {
    console.warn('한국 매크로 조회 실패:', e.message.slice(0, 60));
    return null;
  }
}

// B. 공시 유형별 특화 수치 파싱 (DART 전용)
function parseDartSpecific(text, filingType) {
  if (!text || !filingType) return null;

  const toNum = (s) => s ? parseInt(s.replace(/,/g, '')) : null;
  const fmtWon = (n) => {
    if (!n) return null;
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}조원`;
    if (n >= 10000)     return `${(n / 10000).toFixed(0)}억원`;
    if (n >= 100)       return `${(n / 100).toFixed(0)}백만원`;
    return `${n.toLocaleString()}원`;
  };

  // ── DART-수주: 수주금액 / 매출 대비 비율 / 발주처 / 계약기간 ──────────────
  if (filingType === 'DART-수주') {
    const amtM   = /계약금액[^0-9￦\₩]*([0-9,]+)/.exec(text);
    const ratioM = /매출액\s*대비\s*\(?%?\)?\s*[│|]?\s*([0-9.]+)/.exec(text)
                || /매출\s*대비[^0-9]*([0-9.]+)\s*%/.exec(text);
    const clientM = /계약상대방[^가-힣A-Za-z\(（]*([가-힣A-Za-z0-9(（\)\）\s&.,]+?)(?:\s*[│|\n]|계약|$)/.exec(text);
    const periodM = /계약기간[^0-9]*(\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2}[^0-9\n]{1,5}\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2})/.exec(text)
                 || /납기[^0-9]*(\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2})/.exec(text);

    if (!amtM) return null;
    const parts = [`계약금액 ${fmtWon(toNum(amtM[1]))}`];
    if (ratioM) parts.push(`매출 대비 ${parseFloat(ratioM[1]).toFixed(1)}%`);
    if (clientM) parts.push(`발주처: ${clientM[1].trim().replace(/\s+/g, ' ').slice(0, 25)}`);
    if (periodM) parts.push(`기간: ${periodM[1].trim()}`);
    return `[실제 데이터] ${parts.join(' / ')}`;
  }

  // ── DART-자본: 유상증자 or 자사주 취득 ────────────────────────────────────
  if (filingType === 'DART-자본') {
    const parts = [];
    // 유상증자
    const newSharesM  = /발행할\s*주식의?\s*수[^0-9]*([0-9,]+)/.exec(text)
                     || /신주\s*(?:발행|배정)\s*주식수?[^0-9]*([0-9,]+)/.exec(text);
    const issuePriceM = /(?:예정\s*)?발행가액?[^0-9]*([0-9,]+)/.exec(text);
    const purposeM    = /(?:자금\s*조달의?\s*목적|발행\s*목적)[^\n]*\n?\s*([가-힣\w\s·,]+?)(?:[│|\n]|$)/.exec(text);
    // 자사주
    const buybackShareM = /취득\s*예정\s*주식\s*수?[^0-9]*([0-9,]+)/.exec(text);
    const buybackAmtM   = /취득\s*예정\s*금액[^0-9]*([0-9,]+)/.exec(text);

    if (newSharesM)    parts.push(`신주 ${toNum(newSharesM[1]).toLocaleString()}주 발행`);
    if (issuePriceM)   parts.push(`발행가 ${toNum(issuePriceM[1]).toLocaleString()}원`);
    if (buybackShareM) parts.push(`자사주 취득 ${toNum(buybackShareM[1]).toLocaleString()}주`);
    if (buybackAmtM)   parts.push(`취득금액 ${fmtWon(toNum(buybackAmtM[1]))}`);
    if (purposeM)      parts.push(`목적: ${purposeM[1].trim().slice(0, 20)}`);

    return parts.length ? `[실제 데이터] ${parts.join(' / ')}` : null;
  }

  // ── DART-투자: 투자금액 / 대상 ────────────────────────────────────────────
  if (filingType === 'DART-투자') {
    const amtM    = /(?:투자|취득|출자)\s*금액[^0-9]*([0-9,]+)/.exec(text);
    const targetM = /(?:투자|피투자|취득)\s*대상[^가-힣A-Za-z\(（]*([가-힣A-Za-z0-9(（\s]+?)(?:[│|\n]|$)/.exec(text);
    const purposeM = /(?:투자|취득)\s*목적[^\n]*\n?\s*([가-힣\w\s·,]+?)(?:[│|\n]|$)/.exec(text);

    if (!amtM) return null;
    const parts = [`투자금액 ${fmtWon(toNum(amtM[1]))}`];
    if (targetM) parts.push(`대상: ${targetM[1].trim().slice(0, 25)}`);
    if (purposeM) parts.push(`목적: ${purposeM[1].trim().slice(0, 20)}`);
    return `[실제 데이터] ${parts.join(' / ')}`;
  }

  return null;
}

// 3. 내부자 거래 신호 (EDGAR Form 4 — 공시일 기준 15일 내)
async function fetchInsiderSignal(cikRaw, filingDate) {
  try {
    const cik     = String(parseInt(cikRaw)).padStart(10, '0');
    const cutoff  = new Date(filingDate + 'T23:59:59Z');
    const startDt = new Date(filingDate + 'T00:00:00Z');
    startDt.setDate(startDt.getDate() - 15);

    const { data } = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`,
      { headers: { 'User-Agent': 'Context.ai info@disclosai.kr' }, timeout: 8000 });

    const forms   = data.filings?.recent?.form          || [];
    const dates   = data.filings?.recent?.filingDate    || [];
    const accNums = data.filings?.recent?.accessionNumber || [];
    const primDocs = data.filings?.recent?.primaryDocument || [];

    const entries = [];
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] !== '4') continue;
      const fd = new Date(dates[i]);
      if (fd < startDt || fd > cutoff) continue;
      const accFlat = accNums[i]?.replace(/-/g, '');
      entries.push({
        xmlUrl: `https://www.sec.gov/Archives/edgar/data/${parseInt(cikRaw)}/${accFlat}/${primDocs[i]}`
      });
      if (entries.length >= 5) break;
    }

    if (!entries.length) return { salesCount: 0, salesAmountM: 0, form4Count: 0, signal: 'neutral', detail: '15일 내 임원 거래 없음' };

    let totalValue = 0, salesTx = 0;
    await Promise.allSettled(entries.slice(0, 4).map(async ({ xmlUrl }) => {
      try {
        const { data: xml } = await axios.get(xmlUrl, { headers: EDGAR_HEADERS, timeout: 5000 });
        for (const m of xml.matchAll(/<transactionCode>S<\/transactionCode>[\s\S]{0,600}?<transactionShares>\s*<value>([\d.]+)<\/value>[\s\S]{0,300}?<transactionPricePerShare>\s*<value>([\d.]+)<\/value>/gi)) {
          const v = parseFloat(m[1]) * parseFloat(m[2]);
          if (v > 0) { totalValue += v; salesTx++; }
        }
      } catch {}
    }));

    const salesAmountM = parseFloat((totalValue / 1_000_000).toFixed(2));
    const signal  = salesTx > 0 && salesAmountM > 1 ? 'negative' : salesTx > 0 ? 'caution' : 'neutral';
    const detail  = salesTx > 0
      ? `${salesTx}건 매도, 총 $${salesAmountM}M (15일 내)`
      : `${entries.length}건 Form 4 제출 (매수 또는 옵션 행사)`;
    return { salesCount: salesTx, salesAmountM, form4Count: entries.length, signal, detail };
  } catch { return { salesCount: 0, salesAmountM: 0, form4Count: 0, signal: 'neutral', detail: '내부자 거래 조회 실패' }; }
}

// ── 공시 유형 감지 ────────────────────────────────────────────────────────
function detectFilingType(title, source) {
  const t = title.toUpperCase();
  if (source === 'edgar') {
    if (t.includes('10-K')) return '10-K';
    if (t.includes('10-Q')) return '10-Q';
    // 8-K 세부 아이템
    if (/임원|CEO|CFO|COO|CTO|OFFICER|DIRECTOR|5\.02/.test(title)) return '8-K-인사';
    if (/M&A|ACQUI|MERGER|MERGER|합병|인수|2\.01/.test(title)) return '8-K-MA';
    if (/실적|EARNINGS|REVENUE|OPERATIONS|2\.02/.test(title)) return '8-K-실적';
    return '8-K-기타';
  }
  // DART
  if (/수주|공급계약|단일판매/.test(title)) return 'DART-수주';
  if (/실적|매출|영업이익|잠정/.test(title)) return 'DART-실적';
  if (/투자|증설|인수|합병|M&A/.test(title)) return 'DART-투자';
  if (/임원|대표이사|CEO/.test(title)) return 'DART-인사';
  if (/자기주식|유상증자|감자|배당/.test(title)) return 'DART-자본';
  if (/사업보고|반기보고|분기보고/.test(title)) return 'DART-정기';
  return 'DART-기타';
}

// 유형별 핵심 추출 지침
function getTypeInstruction(filingType) {
  const map = {
    '10-Q':      '① 매출액과 YoY·QoQ 성장률 ② 영업이익과 영업마진 변화 ③ 순이익·EPS ④ 사업 세그먼트별 실적 ⑤ 다음 분기 가이던스',
    '10-K':      '① 연간 매출·영업이익·순이익과 성장률 ② 세그먼트별 기여도 ③ 현금흐름(영업·잉여) ④ 신규 리스크 팩터 ⑤ 주주환원(배당·자사주) 계획',
    '8-K-실적':  '① 매출액과 컨센서스 대비 결과(beat/miss) ② EPS와 컨센서스 대비 ③ 다음 분기/연간 가이던스 ④ 핵심 사업부 실적',
    '8-K-인사':  '① 교체 임원의 이름·직책 ② 전임자 퇴임 이유 ③ 신임자 경력·전문성 ④ 효력 발생일 ⑤ 전략 변화 가능성',
    '8-K-MA':    '① 인수/피인수 대상과 거래 규모 ② 전략적 목적·시너지 ③ 주당 EPS 희석 여부 ④ 완료 예상 시점',
    '8-K-기타':  '① 공시의 핵심 사건 ② 재무적 영향 규모 ③ 타임라인',
    'DART-실적': '① 매출액과 YoY 성장률 ② 영업이익과 영업이익률 ③ 컨센서스 대비(있으면) ④ 부문별 실적',
    'DART-수주': '① 수주 금액과 발주처 ② 계약 기간 ③ 전체 수주잔고 대비 비중 ④ 전략적 의미',
    'DART-투자': '① 투자 금액과 대상 ② 목적(증설/신사업/M&A) ③ 재원 조달 방법 ④ 완공/효과 시점',
    'DART-인사': '① 변경 임원 이름·직책 ② 사유 ③ 신임자 경력 ④ 경영 전략 변화 시사점',
    'DART-자본': '① 규모와 방법(자사주/유상증자 등) ② 목적 ③ 주주 희석/환원 효과',
    'DART-정기': '① 연간/분기 매출·영업이익 ② 전년 대비 증감 ③ 핵심 사업부 변화 ④ 배당·주주환원',
    'DART-기타': '① 공시의 핵심 내용 ② 재무적 영향 ③ 향후 일정',
  };
  return map[filingType] || map['8-K-기타'];
}

// ── 분석 결과 캐시 (공시별, 24시간 TTL) — 동시 접속 시 Gemini 중복 호출 방지 ──
const _analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

// ── Gemini AI 요약 + 영향 분석 ────────────────────────────────────────────
app.post('/api/analyze/summary', async (req, res) => {
  const { title, company, source, date, id, url } = req.body;

  if (!genAI) {
    return res.json({
      status: 'no_key',
      summary: `[Gemini API 키 미설정] aistudio.google.com에서 발급 후 환경변수에 입력하세요.`,
      sentiment: 'neutral', score: 0, factors: [], impact: '',
    });
  }

  // 캐시 키: 공시 고유 ID 또는 URL, 없으면 company+date+title 해시
  const cacheKey = id || url || `${company}__${date}__${title}`;
  const cached = _analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ANALYSIS_CACHE_TTL) {
    return res.json({ status: 'ok', ...cached.data, _cached: true });
  }

  try {
    const cikFromUrl = url?.match(/\/edgar\/data\/(\d+)\//)?.[1];
    const formType   = (title.match(/\[(10-[QK]|8-K)\]/) || [])[1] || '';

    const ticker = req.body.ticker || null;
    const market = req.body.market || '';

    // DART corp_code — company 이름으로 lookup (structured fallback에 필요)
    const dartTarget = source === 'dart'
      ? DART_TARGETS.find(t => t.name === company)
      : null;
    const dartCorpCode = dartTarget?.corp_code || null;

    const [docText, macro, krMacro, insider, fmp, momentum] = await Promise.all([
      source === 'dart' && id
        ? fetchDartDocText(id, dartCorpCode, date)
        : source === 'edgar' && url
          ? fetchEdgarDocText(url, formType)
          : Promise.resolve(null),
      source === 'edgar'   // 미국 매크로(VIX·금리)는 EDGAR 전용
        ? fetchMacroContext(date)
        : Promise.resolve({ vix: null, tnx: null, vixSignal: 'neutral', tnxSignal: 'neutral' }),
      source === 'dart'    // 한국 매크로(원/달러)는 DART 전용
        ? fetchKoreanMacro(date)
        : Promise.resolve(null),
      source === 'edgar' && cikFromUrl
        ? fetchInsiderSignal(cikFromUrl, date)
        : Promise.resolve({ salesCount: 0, salesAmountM: 0, form4Count: 0, signal: 'neutral', detail: 'EDGAR 아님' }),
      source === 'edgar' && ticker
        ? fetchFmpData(ticker, date)
        : Promise.resolve(null),
      ticker
        ? fetchMomentum30(ticker, market, date)
        : Promise.resolve(null),
    ]);

    const nlp = computeNlpSentiment(docText);

    const filingType      = detectFilingType(title, source);
    const typeInstruction = getTypeInstruction(filingType);

    const FULL_THRESHOLD = 4000;
    let textForPrompt = docText;
    let isFullDoc     = false;
    if (docText) {
      if (docText.length <= FULL_THRESHOLD) { isFullDoc = true; }
      else { textForPrompt = extractFinancialSection(docText); }
    }

    const nlpLine     = nlp
      ? `NLP 감성: 부정 ${nlp.negCount}개(${nlp.negRate}/천단어) / 긍정 ${nlp.posCount}개(${nlp.posRate}/천단어)`
      : 'NLP 감성: 원문 없음';
    // 매크로는 미국 기업(Edgar)에만 적용 — 국내 기업엔 포함하지 않음
    const macroLine   = source === 'edgar'
      ? (macro.vix != null
          ? `매크로: VIX ${macro.vix}, 미국 10년물 ${macro.tnx}%`
          : '매크로: 조회 실패')
      : null;
    const insiderLine = insider.salesCount > 0
      ? `내부자 거래: ${insider.detail}`
      : insider.form4Count > 0
        ? `내부자 거래: Form 4 ${insider.form4Count}건 제출 (매도 없음)`
        : '내부자 거래: 15일 내 없음';

    const momentumLine  = momentum?.comment || null;
    const growthLine = fmp?.growthLine || null;

    // DART 전용: 원문 파싱 (재무수치 + 유형별 특화 수치)
    const dartFinLine      = source === 'dart' ? parseDartFinancials(docText) : null;
    const dartSpecificLine = source === 'dart' ? parseDartSpecific(docText, filingType) : null;
    const krMacroLine      = krMacro?.comment || null;

    // P/E 직접 계산 (Twelve Data 마지막 주가 ÷ FMP TTM EPS) — ratios-ttm API 호출 없이 밸류에이션 산출
    let valuationLine = null;
    if (source === 'edgar') {
      const lastPrice = momentum?.lastPrice || null;
      const ttmEps    = fmp?.ttmEps || null;
      if (lastPrice && ttmEps && ttmEps > 0) {
        const pe = lastPrice / ttmEps;
        const peStr = `P/E ${Math.round(pe)}x`;
        if      (pe > 100) valuationLine = `${peStr} → ⚠️ 극단적 고평가 — 완벽한 실적 이상을 요구하는 밸류에이션`;
        else if (pe > 50)  valuationLine = `${peStr} → 주의 — 높은 밸류에이션으로 실망 매물 가능성`;
        else if (pe > 0)   valuationLine = `${peStr} → 적정 수준`;
      }
    }

    const hasDoc = !!textForPrompt;
    const prompt = `기업명: ${company}
공시 일자: ${date}
공시 유형: ${filingType}
공시 제목: ${title}
${hasDoc ? `\n[공시 원문${isFullDoc ? ' — 전체' : ' — 핵심 섹션'}]\n${textForPrompt}\n` : '\n(원문 미확보 — 제목·유형 기반 분석)\n'}
━━━ 주가 예측 변수 ━━━
① 주요 재무실적: ${source === 'dart'
  ? (dartFinLine || '원문에서 매출·영업이익·당기순이익 수치와 전기 대비 증감률을 직접 추출하세요')
  : (fmp?.consensusLine ? `[실제 데이터] ${fmp.consensusLine}` : '원문에서 차기 가이던스와 컨센서스 대비 beat/miss를 직접 추출하세요')}
② 공시 핵심 수치: ${source === 'dart'
  ? (dartSpecificLine || '원문에서 이 공시 유형의 핵심 수치를 직접 추출하세요')
  : (fmp?.capexLine ? `[실제 데이터] ${fmp.capexLine}` : '원문에서 자본지출 증가율과 매출 성장률을 직접 추출하세요')}
③ ${nlpLine}
④ 매크로: ${source === 'dart'
  ? (krMacroLine || '환율 데이터 없음')
  : (macroLine || '매크로 데이터 없음')}
━━━ 과열·하방 리스크 지표 ━━━
⑤ 공시 전 모멘텀: ${momentumLine || '데이터 없음'}
⑥ 밸류에이션: ${valuationLine || '데이터 없음'}
⑦ 성장 추이: ${growthLine || '데이터 없음'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

핵심 추출 항목:
${typeInstruction}

규칙:
- summary는 공시에서 밝힌 사실만 기술하세요. "~할 것으로 예상", "주가에 영향", "상승/하락 가능성" 등 주가 예측·전망 표현은 summary에 절대 포함 금지
- [실제 데이터] 표시 항목은 해당 수치를 반드시 impact에 활용하세요
- 원문에 있는 실제 수치만 인용하세요 (수치 생성 금지)
- 수치 미기재 시 "미기재"로 표시
- score는 8개 변수를 종합한 -100~100 정수

impact 작성 지침:
impact는 "이 공시가 주가에 왜, 어떻게 영향을 주는가"를 분석하는 곳입니다. 공시 내용을 다시 요약하는 것이 아닙니다.

⛔ 절대 금지 — impact에서 공시 내용을 그대로 반복하지 마세요.
예) "KSS해운과 5,048억 계약을 체결했으며 2029년까지 진행된다" → 이런 문장은 summary와 중복이므로 금지.

✅ impact가 해야 할 일 — 수치의 의미와 주가 영향을 해석하세요.
예) "5,048억 수주는 분기 매출의 약 11%에 해당하는 대형 계약으로, 수주잔고 확충과 2027~2029년 매출 가시성 확보에 긍정적이다."

작성 구조 (2~4문장):
[1문장 — 수치의 의미 해석, 필수]
공시의 핵심 수치가 기업 규모·실적 대비 어느 수준인지 해석하세요.
- 수주 공시: 수주액이 분기/연간 매출의 몇 %인지, 수주잔고에 어떤 영향인지
- 실적 공시: 컨센서스 대비 beat/miss 폭이 주가 기대치와 어떻게 다른지
- 유상증자: 희석 규모와 조달 목적이 기업가치에 미치는 영향

[나머지 문장 — 리스크·기회 판단, 조건부]
해당하는 항목만 포함, 없으면 생략:
- 공시 전 모멘텀 ⚠️: 이미 선반영된 기대감과 차익 실현 가능성
- 밸류에이션 ⚠️: 고평가 부담이 긍정적 공시에도 상승을 제한할 수 있는지
- 성장 추이: 컨센서스 beat 시 "둔화" 표현 절대 금지
${source === 'dart'
  ? `- 환율 ⚠️: 수출 비중 높은 기업(조선·방산·반도체)은 강달러 수혜 구체적 언급`
  : `- 매크로: VIX > 25이거나 금리 > 4.5% 또는 < 3.5%일 때만\n- 내부자 거래: 매도 $1M 이상일 때만`}

절대 금지: 수치나 해석 없이 "긍정적", "부정적", "영향을 미칠 것" 같은 단어만 쓰지 마세요.

⚠️ summary 필드 엄격 규칙:
summary에는 공시 원문에 명시된 수치와 사실만 기술합니다.
다음 표현은 summary에 절대 등장해서는 안 됩니다:
- "예상됩니다", "전망됩니다", "기대됩니다"
- "변동성", "주가", "시장 반응", "투자자", "매수/매도"
- "~할 것으로", "~가능성", "~우려", "~기대"
이러한 표현은 오직 impact 필드에만 사용하세요.

코드블록 없이 순수 JSON만 출력하세요:
{
  "summary": "공시에서 발표한 수치와 사실만 3~5문장. 예측·전망·주가 관련 표현 완전 배제.",
  "sentiment": "positive 또는 negative 또는 neutral",
  "score": 정수,
  "factors": ["핵심 요인 3개, 수치 포함"],
  "impact": "주가 영향 분석. 한국어."
}`;

    // AI 호출: Gemini
    if (!genAI) throw new Error('Gemini API 키 미설정');
    let raw;
    for (const modelName of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        raw = result.response.text();
        if (raw) { console.log(`[AI] Gemini ${modelName} 사용`); break; }
      } catch (e) {
        console.warn(`[Gemini] ${modelName} 실패:`, e.message.slice(0, 60));
      }
    }
    if (!raw) throw new Error('Gemini 호출 실패');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // ── summary에서 예측·전망 문장 제거 ─────────────────────────────────
      if (parsed.summary) {
        const PREDICT_PATTERN = /(?:예상|전망|기대|변동성|주가|투자자|매수|매도|가능성|우려|상승|하락|반영).{0,15}(?:됩니다|됩니다\.|입니다\.|있습니다\.)$/;
        const sentences = parsed.summary.split(/(?<=[.。])\s+/);
        const filtered = sentences.filter(s => !PREDICT_PATTERN.test(s.trim()));
        if (filtered.length < sentences.length) {
          parsed.summary = filtered.join(' ').trim();
        }
      }

      // ── ⚠️ 리스크 경고 강제 삽입 (AI가 무시해도 impact 앞에 붙임) ────────
      const warnings = [];

      // 밸류에이션 극단적 고평가
      if (valuationLine && valuationLine.includes('⚠️')) {
        const alreadyMentioned = parsed.impact && /밸류에이션|고평가|P\/E|P\/S/.test(parsed.impact);
        if (!alreadyMentioned) {
          warnings.push(`⚠️ 밸류에이션 경고: ${valuationLine} — 실적이 좋더라도 높은 기대치가 이미 주가에 반영돼 있어 차익 실현 압력이 발생할 수 있습니다.`);
        }
      }

      // 공시 전 모멘텀 과열
      if (momentumLine && momentumLine.includes('⚠️')) {
        const alreadyMentioned = parsed.impact && /모멘텀|급등|선반영|차익/.test(parsed.impact);
        if (!alreadyMentioned) {
          warnings.push(`⚠️ 모멘텀 경고: ${momentumLine}`);
        }
      }

      if (warnings.length > 0) {
        parsed.impact = warnings.join(' ') + (parsed.impact ? ' ' + parsed.impact : '');
      }

      // 분석 결과 캐시 저장
      _analysisCache.set(cacheKey, { data: parsed, ts: Date.now() });

      res.json({ status: 'ok', ...parsed });
    } else {
      res.json({ status: 'ok', summary: raw, sentiment: 'neutral', score: 0, factors: [], impact: '' });
    }
  } catch (err) {
    console.error('Gemini 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 네이버 fchart XML 파싱 (한국 주식/지수) ──────────────────────────────
async function fetchNaverChart(symbol, count = 600) {
  const { data } = await axios.get('https://fchart.stock.naver.com/sise.nhn', {
    params: { symbol, timeframe: 'day', count, requestType: 0 },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000,
    responseType: 'arraybuffer',
  });
  // EUC-KR 인코딩 → 날짜/숫자만 ASCII이므로 latin1로 디코딩해도 무관
  const xml = Buffer.from(data).toString('latin1');
  const items = [];
  const re = /data="(\d{8})\|([^|]+)\|[^|]+\|[^|]+\|([^|]+)\|/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    // date: YYYYMMDD → YYYY-MM-DD, close: index 2
    const d = m[1];
    items.push({ date: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, close: parseFloat(m[3]) });
  }
  return items; // 오래된 순 (oldest-first)
}

// ── 유사 공시 주가 영향 조회 (KR: 네이버 / US: Twelve Data) ───────────────
app.get('/api/price-impact', async (req, res) => {
  const { ticker, market, date } = req.query;
  if (!ticker || !date) return res.json({ status: 'no_params' });

  const cacheKey = `price2-${ticker}-${date}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const isKorean = market === 'KOSPI' || market === 'KOSDAQ';

  try {
    let stockVals, indexVals;

    if (isKorean) {
      // 네이버 fchart: 최근 600거래일 (약 2.4년)
      [stockVals, indexVals] = await Promise.all([
        fetchNaverChart(ticker, 600),
        fetchNaverChart('KOSPI', 600).catch(() => null),
      ]);
    } else {
      // Twelve Data: 미국 주식
      if (!process.env.TWELVEDATA_API_KEY) return res.json({ status: 'no_key' });
      const base = new Date(date + 'T00:00:00Z');
      const startDate = new Date(base.getTime() - 10 * 86400000).toISOString().slice(0, 10);
      const endDate   = new Date(base.getTime() +  5 * 86400000).toISOString().slice(0, 10);
      const fetchTD = async (symbol) => {
        const { data } = await axios.get('https://api.twelvedata.com/time_series', {
          params: { symbol, interval: '1day', start_date: startDate, end_date: endDate,
                    apikey: process.env.TWELVEDATA_API_KEY, format: 'JSON' },
          timeout: 10000,
        });
        if (data.status === 'error' || !Array.isArray(data.values)) return null;
        return data.values.reverse().map(v => ({ date: v.datetime, close: parseFloat(v.close) }));
      };
      [stockVals, indexVals] = await Promise.all([
        fetchTD(ticker),
        fetchTD('SPX').catch(() => null),
      ]);
    }

    if (!stockVals || stockVals.length < 2) return res.json({ status: 'no_data' });

    // 공시일 기준 직전/직후 거래일 인덱스
    let dayIdx = stockVals.findIndex(v => v.date >= date);
    if (dayIdx < 0) dayIdx = stockVals.length - 1;
    const beforeIdx = Math.max(0, dayIdx - 1);
    const afterIdx  = Math.min(stockVals.length - 1, dayIdx + 1);

    const cBefore = stockVals[beforeIdx]?.close;
    const cAfter  = stockVals[afterIdx]?.close;
    const priceChange = (cBefore && cAfter && beforeIdx !== afterIdx)
      ? Math.round((cAfter - cBefore) / cBefore * 1000) / 10 : null;

    let marketChange = null;
    if (indexVals && indexVals.length > afterIdx) {
      const iBefore = indexVals[beforeIdx]?.close;
      const iAfter  = indexVals[afterIdx]?.close;
      if (iBefore && iAfter && beforeIdx !== afterIdx)
        marketChange = Math.round((iAfter - iBefore) / iBefore * 1000) / 10;
    }

    const result = {
      status: 'ok', priceChange, marketChange,
      relativeChange: (priceChange !== null && marketChange !== null)
        ? Math.round((priceChange - marketChange) * 10) / 10 : null,
    };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.warn('price-impact 조회 실패:', err.message.slice(0, 80));
    res.json({ status: 'error' });
  }
});

// ── 분석 캐시 초기화 ─────────────────────────────────────────────────────
app.post('/api/cache/clear', (_, res) => {
  const count = _analysisCache.size;
  _analysisCache.clear();
  console.log(`[Cache] 분석 캐시 초기화: ${count}건 삭제`);
  res.json({ status: 'ok', cleared: count });
});

// ── 서버 상태 확인 ────────────────────────────────────────────────────────
app.get('/api/status', (_, res) => res.json({
  dart:   !!process.env.DART_API_KEY,
  gemini: !!process.env.GEMINI_API_KEY,
  time:   new Date().toISOString(),
}));

app.listen(PORT, () => {
  console.log(`\n🚀 Context.ai 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`   DART API:   ${process.env.DART_API_KEY ? '✅ 연결됨' : '❌ 키 없음'}`);
  console.log(`   Gemini AI:  ${process.env.GEMINI_API_KEY ? '✅ 연결됨' : '❌ 키 없음'}`);
  console.log(`   EDGAR:      ✅ 공개 API (키 불필요)`);
  console.log(`   대상기업:   🇰🇷 ${DART_TARGETS.length}개  🇺🇸 ${EDGAR_TARGETS.length}개\n`);
});
