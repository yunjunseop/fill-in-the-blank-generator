import { Fragment, useMemo, useRef, useState } from 'react'
import './App.css'
import pkg from '../package.json'

async function extractPdfPages(file) {
  const [pdfjsLib, { default: pdfjsWorker }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const pages = []
  const visualsByPage = {}
  const layoutsByPage = {}
  const printPagesByPage = {}
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1.5 })
    const content = await page.getTextContent()
    const { text, lineTops, layout } = extractPdfPageText(content.items, viewport)
    pages.push(text)
    layoutsByPage[i - 1] = layout
    try {
      const { visuals, printPage } = await extractPdfPageVisuals(page, viewport)
      printPagesByPage[i - 1] = printPage
      visualsByPage[i - 1] = visuals.map((visual) => {
        const visualColumn = layout.columnCount === 2 && visual.sourceWidth < viewport.width * 0.65
          ? visual.centerX < viewport.width / 2 ? 1 : 2
          : 0
        const firstLineBelow = lineTops.findIndex((lineTop, lineIndex) => (
          Number.isFinite(lineTop)
          && (visualColumn === 0 || layout.lineColumns[lineIndex] === visualColumn)
          && lineTop > visual.order
        ))
        const columnLineIndexes = layout.lineColumns
          .map((column, lineIndex) => (visualColumn === 0 || column === visualColumn ? lineIndex : -1))
          .filter((lineIndex) => lineIndex >= 0)
        const fallbackLine = columnLineIndexes.length ? columnLineIndexes.at(-1) + 1 : lineTops.length
        return {
          ...visual,
          column: visualColumn,
          insertBeforeLine: firstLineBelow === -1 ? fallbackLine : firstLineBelow,
        }
      })
    } catch {
      visualsByPage[i - 1] = []
      printPagesByPage[i - 1] = null
    }
  }
  return { pages, visualsByPage, layoutsByPage, printPagesByPage }
}

async function extractPdfPageVisuals(page, viewport) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) return { visuals: [], printPage: null }

  await page.render({ canvas, canvasContext: context, viewport, recordImages: true }).promise
  const printPage = {
    src: canvas.toDataURL('image/jpeg', 0.96),
    width: canvas.width,
    height: canvas.height,
  }
  const coordinates = page.imageCoordinates || []
  const visuals = []
  const seen = new Set()

  for (let i = 0; i + 5 < coordinates.length && visuals.length < 12; i += 6) {
    const xs = [coordinates[i], coordinates[i + 2], coordinates[i + 4]]
    const ys = [coordinates[i + 1], coordinates[i + 3], coordinates[i + 5]]
    if (![...xs, ...ys].every(Number.isFinite)) continue
    const left = Math.max(0, Math.floor(Math.min(...xs) * canvas.width))
    const top = Math.max(0, Math.floor(Math.min(...ys) * canvas.height))
    const right = Math.min(canvas.width, Math.ceil(Math.max(...xs) * canvas.width))
    const bottom = Math.min(canvas.height, Math.ceil(Math.max(...ys) * canvas.height))
    const width = right - left
    const height = bottom - top
    if (width < 60 || height < 40 || width * height < 4000) continue

    const boxKey = `${Math.round(left / 5)}:${Math.round(top / 5)}:${Math.round(width / 5)}:${Math.round(height / 5)}`
    if (seen.has(boxKey)) continue
    seen.add(boxKey)

    try {
      const maxWidth = 1000
      const scale = Math.min(1, maxWidth / width)
      const crop = document.createElement('canvas')
      crop.width = Math.max(1, Math.round(width * scale))
      crop.height = Math.max(1, Math.round(height * scale))
      const cropContext = crop.getContext('2d', { alpha: false })
      if (!cropContext) continue
      cropContext.fillStyle = '#fff'
      cropContext.fillRect(0, 0, crop.width, crop.height)
      cropContext.drawImage(canvas, left, top, width, height, 0, 0, crop.width, crop.height)
      visuals.push({
        src: crop.toDataURL('image/jpeg', 0.9),
        width: crop.width,
        height: crop.height,
        sourceWidth: width,
        sourceHeight: height,
        order: top,
        centerX: left + width / 2,
      })
    } catch {
      // A malformed image box should not prevent the full original page from printing.
    }
  }

  const orderedVisuals = visuals
    .sort((a, b) => a.order - b.order)
    .map((visual, index) => ({ ...visual, id: `pdf-visual-${index + 1}`, number: index + 1 }))
  return {
    visuals: orderedVisuals,
    printPage,
  }
}

function extractPdfPageText(items, viewport) {
  const pageWidth = viewport.width
  const middle = pageWidth / 2
  const positionedItems = items
    .filter((item) => 'str' in item && item.str.trim())
    .map((item) => {
      const x = item.transform?.[4] || 0
      const y = item.transform?.[5] || 0
      const height = Math.abs(item.height || item.transform?.[3] || 0)
      const [viewportX, baselineY] = viewport.convertToViewportPoint(x, y)
      const [, capY] = viewport.convertToViewportPoint(x, y + height)
      return {
        text: item.str,
        x: viewportX,
        top: Math.min(baselineY, capY),
        width: Math.max(Math.abs((item.width || 0) * viewport.scale), 1),
        height: Math.max(Math.abs(baselineY - capY), 1),
      }
    })
    .sort((a, b) => a.top - b.top || a.x - b.x)

  const rowBands = []
  for (const item of positionedItems) {
    const band = rowBands.findLast((candidate) => Math.abs(candidate.top - item.top) <= Math.max(2, candidate.height * 0.45, item.height * 0.45))
    if (band) {
      band.items.push(item)
      band.top = (band.top * (band.items.length - 1) + item.top) / band.items.length
      band.height = Math.max(band.height, item.height)
    } else {
      rowBands.push({ items: [item], top: item.top, height: item.height })
    }
  }

  const segments = []
  for (const band of rowBands) {
    const sorted = band.items.sort((a, b) => a.x - b.x)
    let segmentItems = []
    for (const item of sorted) {
      const previous = segmentItems.at(-1)
      const gap = previous ? item.x - (previous.x + previous.width) : 0
      const crossesPageMiddle = previous && previous.x + previous.width < middle && item.x > middle
      const splitAtGutter = crossesPageMiddle && gap > Math.max(pageWidth * 0.035, band.height * 2.5)
      if (splitAtGutter) {
        segments.push(buildPdfLineSegment(segmentItems, band.top, band.height))
        segmentItems = []
      }
      segmentItems.push(item)
    }
    if (segmentItems.length) segments.push(buildPdfLineSegment(segmentItems, band.top, band.height))
  }

  const leftCandidates = segments.filter((line) => line.centerX < middle && line.xMax < pageWidth * 0.59)
  const rightCandidates = segments.filter((line) => line.centerX >= middle && line.xMin > pageWidth * 0.41)
  const leftRange = getVerticalRange(leftCandidates)
  const rightRange = getVerticalRange(rightCandidates)
  const overlap = Math.min(leftRange.max, rightRange.max) - Math.max(leftRange.min, rightRange.min)
  const shorterRange = Math.min(leftRange.max - leftRange.min, rightRange.max - rightRange.min)
  const hasTwoColumns = leftCandidates.length >= 4
    && rightCandidates.length >= 4
    && shorterRange > 0
    && overlap / shorterRange > 0.45

  let orderedLines
  if (hasTwoColumns) {
    const commonColumnTop = Math.max(leftRange.min, rightRange.min)
    const leftBody = leftCandidates.filter((line) => line.top >= commonColumnTop - line.height * 1.5)
    const rightBody = rightCandidates.filter((line) => line.top >= commonColumnTop - line.height * 1.5)
    const leftSet = new Set(leftBody)
    const rightSet = new Set(rightBody)
    const headers = segments.filter((line) => !leftSet.has(line) && !rightSet.has(line) && line.top < commonColumnTop)
    const footers = segments.filter((line) => !leftSet.has(line) && !rightSet.has(line) && line.top >= commonColumnTop)
    orderedLines = [
      ...headers.sort(sortPdfLines).map((line) => ({ ...line, column: 0 })),
      ...leftBody.sort(sortPdfLines).map((line) => ({ ...line, column: 1 })),
      ...rightBody.sort(sortPdfLines).map((line) => ({ ...line, column: 2 })),
      ...footers.sort(sortPdfLines).map((line) => ({ ...line, column: 0 })),
    ]
  } else {
    orderedLines = segments.sort(sortPdfLines).map((line) => ({ ...line, column: 0 }))
  }

  const lines = []
  const lineTops = []
  const lineColumns = []
  const lineRuns = []
  let previousLine = null
  for (const line of orderedLines) {
    if (previousLine && previousLine.column === line.column) {
      const verticalGap = line.top - previousLine.top
      if (verticalGap > Math.max(previousLine.height, line.height) * 1.8) {
        lines.push('')
        lineTops.push(null)
        lineColumns.push(line.column)
        lineRuns.push([])
      }
    }
    lines.push(line.text)
    lineTops.push(line.top)
    lineColumns.push(line.column)
    lineRuns.push(line.runs)
    previousLine = line
  }

  return {
    text: lines.join('\n'),
    lineTops,
    layout: {
      columnCount: hasTwoColumns ? 2 : 1,
      lineColumns,
      lineRuns,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    },
  }
}

function buildPdfLineSegment(items, top, height) {
  let text = ''
  let previous = null
  const runs = []
  for (const item of items) {
    if (previous && text && !/\s$/.test(text) && !/^\s/.test(item.text)) {
      const gap = item.x - (previous.x + previous.width)
      const averageCharacterWidth = previous.text.length ? previous.width / previous.text.length : 0
      if (gap > Math.max(0.8, averageCharacterWidth * 0.18)) {
        const spaceWidth = Math.max(averageCharacterWidth, height * 0.45, 1)
        text += ' '.repeat(Math.min(10, Math.max(1, Math.round(gap / spaceWidth))))
      }
    }
    const start = text.length
    text += item.text
    runs.push({
      start,
      end: text.length,
      x: item.x,
      top: item.top,
      width: item.width,
      height: item.height,
    })
    previous = item
  }
  const xMin = Math.min(...items.map((item) => item.x))
  const xMax = Math.max(...items.map((item) => item.x + item.width))
  return { text: text.trimEnd(), top, height, xMin, xMax, centerX: (xMin + xMax) / 2, runs }
}

function getVerticalRange(lines) {
  if (!lines.length) return { min: Infinity, max: -Infinity }
  return {
    min: Math.min(...lines.map((line) => line.top)),
    max: Math.max(...lines.map((line) => line.top + line.height)),
  }
}

function sortPdfLines(a, b) {
  return a.top - b.top || a.xMin - b.xMin
}

const EMPTY_SET = new Set()
const EMPTY_OBJ = {}
const EMPTY_ARRAY = []
const DEFAULT_LAYOUT = { columnCount: 1, lineColumns: EMPTY_ARRAY }
const NOOP = () => {}

const LEVELS = [
  { id: 0, label: 'L0', name: '원문 그대로', density: 0, minGapWords: Infinity, densityLabel: '빈칸 없음' },
  { id: 1, label: 'L1', name: '가볍게', density: 0.15, minGapWords: 3 },
  { id: 2, label: 'L2', name: '기본', density: 0.3, minGapWords: 2 },
  { id: 3, label: 'L3', name: '집중', density: 0.45, minGapWords: 1 },
  { id: 4, label: 'L4', name: '심화', density: 0.6, minGapWords: 0 },
]

const HANGUL = /[가-힣]/
const LOGIC_WORDS = ['그러나', '하지만', '따라서', '그러므로', '또한', '그리고', '즉', '왜냐하면', '반면', '결국', '그래서', '한편', '더구나', '게다가', '그럼에도']
const COMMON_STOP = new Set(['것', '수', '등', '때', '이후', '통해', '대한', '위해', '따라', '경우', '정도', '때문'])
const ENGLISH_STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'with', 'as', 'by', 'this', 'that', 'it', 'be', 'have', 'has', 'had'])
const PARTICLES = ['으로부터', '에게서', '한테서', '에서는', '으로는', '에게', '한테', '에서', '으로', '부터', '까지', '보다', '처럼', '은', '는', '이', '가', '의', '을', '를', '과', '와', '로', '도', '만']

function stripParticle(c) {
  for (const p of PARTICLES) {
    if (c.endsWith(p) && c.length > p.length) return c.slice(0, -p.length)
  }
  return c
}

const CATEGORIES = [
  { id: 'common', label: '공통', group: 'subject', test: (c) => c.length >= 2 && HANGUL.test(c) && !COMMON_STOP.has(c) && !LOGIC_WORDS.includes(c) },
  { id: 'korean', label: '국어', group: 'subject', test: (c) => c.length >= 3 && /(적|성|론|법|화|주의|사상)$/.test(c) },
  { id: 'english', label: '영어', group: 'subject', test: (c) => /^[A-Za-z]{3,}$/.test(c) && !ENGLISH_STOP.has(c.toLowerCase()) },
  { id: 'math', label: '수학', group: 'subject', test: (c) => /^[-+]?\d+(\.\d+)?%?$/.test(c) || /(식|정리|함수|공식)$/.test(c) || /[=+\-*/^×÷√±<>≤≥]/.test(c) },
]

const KOREAN_PRONOUNS = new Set(['나', '너', '저', '우리', '저희', '너희', '그', '그녀', '그들', '이것', '그것', '저것', '누구', '무엇', '어디', '자기', '서로', '내', '제', '네'])
const KOREAN_NUMERALS = new Set(['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '첫째', '둘째', '셋째', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십', '백', '천', '만'])
const KOREAN_DETERMINERS = new Set(['이', '그', '저', '새', '헌', '온', '모든', '어느', '어떤', '무슨', '몇', '각', '매', '한', '두', '세', '네'])
const ENGLISH_PRONOUNS = new Set(['my', 'your', 'his', 'her', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'us', 'them', 'this', 'that', 'these', 'those', 'who', 'what', 'which'])
const PREPOSITION_WORDS = new Set(['of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'over', 'under', 'within', 'without', 'toward', 'towards', 'among', 'across', 'behind', 'beside', 'near'])
const ENGLISH_CONJUNCTIONS = new Set(['and', 'or', 'but', 'so', 'yet', 'nor', 'for', 'because', 'although', 'though', 'while', 'whereas', 'if', 'unless', 'when', 'since', 'whether'])
const KOREAN_INTERJECTIONS = new Set(['아', '어', '오', '와', '야', '어머', '아이고', '앗', '어휴', '참', '글쎄', '네', '예', '아니'])
const ENGLISH_INTERJECTIONS = new Set(['hello', 'hi', 'hey', 'oh', 'wow', 'oops', 'ouch', 'alas', 'yes', 'no'])
const ENGLISH_VERBS = new Set(['be', 'am', 'is', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'make', 'makes', 'made', 'get', 'gets', 'got', 'go', 'goes', 'went', 'come', 'comes', 'came', 'take', 'takes', 'took', 'see', 'sees', 'saw', 'know', 'knows', 'knew', 'think', 'thinks', 'thought', 'say', 'says', 'said'])
const ENGLISH_ADJECTIVES = new Set(['good', 'bad', 'new', 'old', 'great', 'small', 'large', 'high', 'low', 'important', 'different', 'same', 'possible', 'necessary'])
const ENGLISH_ADVERBS = new Set(['very', 'too', 'quite', 'rather', 'almost', 'always', 'never', 'often', 'sometimes', 'here', 'there', 'now', 'then'])
const KOREAN_ADVERBS = new Set(['매우', '아주', '너무', '더', '가장', '잘', '못', '빨리', '천천히', '항상', '절대', '자주', '가끔', '이미', '아직', '곧', '바로'])
const KOREAN_ADJECTIVE_ROOTS = /(같|크|작|높|낮|좋|나쁘|많|적|새롭|어렵|쉽|빠르|느리|중요하|필요하|가능하|다르|비슷하)/
const KOREAN_PARTICLE_ENDING = /(으로부터|에게서|한테서|에게|한테|에서|으로|부터|까지|보다|처럼|은|는|이|가|의|을|를|과|와|로|도|만)$/

function getSpecialTypes(clean) {
  const lower = clean.toLowerCase()
  const root = stripParticle(clean)
  const types = new Set()
  const hasKorean = HANGUL.test(clean)
  const isEnglishWord = /^[A-Za-z]+$/.test(clean)
  if (/^\d+(?:\.\d+)?$/.test(clean)) types.add('ko_numeral')

  if (hasKorean) {
    if (KOREAN_PRONOUNS.has(root)) types.add('ko_pronoun')
    if (KOREAN_NUMERALS.has(root)) types.add('ko_numeral')
    if (KOREAN_DETERMINERS.has(clean)) types.add('ko_determiner')
    if (KOREAN_PARTICLE_ENDING.test(clean)) types.add('ko_particle')
    if (KOREAN_INTERJECTIONS.has(root)) types.add('ko_interjection')

    const isVerb = /(하다|한다|했다|하였다|하고|하며|하면|해서|되다|된다|됐다|되었다|되고|되며|되면|있다|없다|이다|이었다|입니다|한다면|하였다면)$/.test(clean)
    const isAdjective = KOREAN_ADJECTIVE_ROOTS.test(clean) && /(다|한|한데|하다|하며|하고|해서|은|는|게|지|웠다|웠던|운|운데|울)$/.test(clean)
    const isAdverb = KOREAN_ADVERBS.has(root) || /(하게|히|적으로)$/.test(clean) || LOGIC_WORDS.includes(clean)
    if (isVerb && !isAdjective) types.add('ko_verb')
    if (isAdjective) types.add('ko_adjective')
    if (isAdverb) types.add('ko_adverb')

    const hasCoreKoreanType = [...types].some((type) => !['ko_particle'].includes(type))
    if (clean.length >= 2 && (!hasCoreKoreanType || types.has('ko_particle'))) types.add('ko_noun')
  }

  if (isEnglishWord) {
    if (ENGLISH_PRONOUNS.has(lower)) types.add('en_pronoun')
    if (PREPOSITION_WORDS.has(lower)) types.add('en_preposition')
    if (ENGLISH_CONJUNCTIONS.has(lower)) types.add('en_conjunction')
    if (ENGLISH_INTERJECTIONS.has(lower)) types.add('en_interjection')
    if (ENGLISH_VERBS.has(lower) || /(ed|ing|en|ify|ise|ize)$/.test(lower)) types.add('en_verb')
    if (ENGLISH_ADJECTIVES.has(lower) || /(able|ible|al|ful|ic|ive|less|ous|ary|ory)$/.test(lower)) types.add('en_adjective')
    if (ENGLISH_ADVERBS.has(lower) || /ly$/.test(lower)) types.add('en_adverb')
    if (![...types].some((type) => type.startsWith('en_'))) types.add('en_noun')
  }

  const hasMathOperator = /[=+\-*/^×÷√±<>≤≥]/.test(clean)
  if (hasMathOperator) types.add('math_formula')
  if (/^[-+]?\d+(?:\.\d+)?(?:%|π|e)?$/.test(clean)) types.add('math_number')
  if (/^(?:[A-Za-z]|[α-ωΑ-Ωπθ])(?:[_^]?\d+|[²³])?$/.test(clean)) types.add('math_variable')
  if (/[=<>≤≥]/.test(clean)) types.add('math_relation')
  return types
}

const KOREAN_POS_BOOSTS = [
  { id: 'ko_noun', label: '명사' },
  { id: 'ko_pronoun', label: '대명사' },
  { id: 'ko_numeral', label: '수사' },
  { id: 'ko_verb', label: '동사' },
  { id: 'ko_adjective', label: '형용사' },
  { id: 'ko_determiner', label: '관형사' },
  { id: 'ko_adverb', label: '부사' },
  { id: 'ko_particle', label: '조사' },
  { id: 'ko_interjection', label: '감탄사' },
]

const ENGLISH_POS_BOOSTS = [
  { id: 'en_noun', label: '명사' },
  { id: 'en_pronoun', label: '대명사' },
  { id: 'en_verb', label: '동사' },
  { id: 'en_adjective', label: '형용사' },
  { id: 'en_adverb', label: '부사' },
  { id: 'en_preposition', label: '전치사' },
  { id: 'en_conjunction', label: '접속사' },
  { id: 'en_interjection', label: '감탄사' },
]

const MATH_BOOSTS = [
  { id: 'math_formula', label: '수식 전체' },
  { id: 'math_number', label: '숫자·상수' },
  { id: 'math_variable', label: '변수·기호' },
  { id: 'math_relation', label: '등식·부등식' },
]

const SPECIAL_BOOSTS = [...KOREAN_POS_BOOSTS, ...ENGLISH_POS_BOOSTS, ...MATH_BOOSTS]

function stableWeightedPriority(value, weight) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const unit = ((hash >>> 0) + 1) / 4294967297
  return -Math.log(unit) / weight
}

function spanDistance(a, b) {
  if (a.end <= b.start) return b.start - a.end
  if (b.end <= a.start) return a.start - b.end
  return -1
}

const FORMATS = [
  { id: 'pdf', label: 'PDF·인쇄' },
  { id: 'word', label: 'Word' },
  { id: 'html', label: 'HTML' },
  { id: 'txt', label: 'TXT' },
  { id: 'md', label: 'MD' },
]

const QUALITY_PRINT_LAYOUTS = [
  { id: 'portrait', label: '세로 1단', description: '일반 세로 용지' },
  { id: 'landscape', label: '가로 1단', description: '넓은 한 단 구성' },
  { id: 'landscape-split', label: '가로 2분할', description: '가로 용지를 좌우 두 단으로 분할' },
]

function stripEdgePunct(raw, start) {
  const leadMatch = raw.match(/^[([{「『"'"'\-·]+/)
  const lead = leadMatch ? leadMatch[0].length : 0
  const trailMatch = raw.match(/[)\]}」』"'"',.!?;:·]+$/)
  const trail = trailMatch ? trailMatch[0].length : 0
  return { start: start + lead, end: start + raw.length - trail, clean: raw.slice(lead, raw.length - trail) }
}

function extractWords(text) {
  return [...text.matchAll(/\S+/g)].map((m) => stripEdgePunct(m[0], m.index)).filter((w) => w.clean.length > 0)
}

function findPhraseSpans(paraText, phrases) {
  const spans = []
  for (const phrase of phrases) {
    const p = phrase.trim()
    if (!p) continue
    let idx = 0
    while ((idx = paraText.indexOf(p, idx)) !== -1) {
      spans.push({ start: idx, end: idx + p.length, clean: p })
      idx += p.length
    }
  }
  return spans
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end
}

function isFigureLine(line) {
  return /^\[?\s*(그림|표|Fig(?:ure)?|Table)\s*\.?\s*\d+/i.test(line.trim())
}

function isHeadingLine(line, index, paragraphs) {
  const text = line.trim()
  if (!text || text.length > 90) return false
  if (/^#{1,6}\s+\S+/.test(text)) return true
  if (/^(주제|제목|소주제|소제목|목차|단원|학습\s*목표|핵심\s*개념|서론|본론|결론)\s*(?:[:：]\s*\S.*)?$/.test(text)) return true
  if (/^제\s*\d+\s*(장|절|항|단원)(?:\s|$)/.test(text)) return true
  if (/^(\d+(?:\.\d+)*[.)]?|[가-하][.)]|[①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?)\s+\S+/.test(text)) return true
  if (/^(\[[^\]]+\]|【[^】]+】|〈[^〉]+〉|《[^》]+》)$/.test(text)) return true
  if (/\.{2,}\s*\d+$/.test(text)) return true

  const separatedByBlank = (index > 0 && !paragraphs[index - 1].trim())
    || (index < paragraphs.length - 1 && !paragraphs[index + 1].trim())
  const shortTitleLike = text.length <= 35
    && text.split(/\s+/).length <= 7
    && !/[.!?。！？]$/.test(text)
    && !/(했다|한다|된다|이다|있다|없다|하였다|됩니다|입니다)$/.test(text)
  return separatedByBlank && shortTitleLike
}

function spanKey(paraIdx, start) {
  return `${paraIdx}:${start}`
}

const LINE_BLANK_MATCH = (c) => c.length >= 2 && (HANGUL.test(c) || /\d/.test(c))

function buildWorksheet({ sourceText, level, selectedCategories, selectedGrammarBoosts = EMPTY_SET, preserveHeadings = true, ignoredHeadings = EMPTY_SET, alwaysBlankLines, neverBlankLines, alwaysList, neverList, manualInclude, manualExclude, visuals = [], excludedVisuals = EMPTY_SET, layout = DEFAULT_LAYOUT, printPage = null }) {
  const paragraphs = sourceText
    ? sourceText.replace(/\r\n?/g, '\n').split('\n')
    : []
  const rawMode = level.id === 0
  const activeCats = CATEGORIES.filter((c) => selectedCategories.has(c.id))
  const subjectOnly = activeCats.filter((c) => c.group === 'subject' && c.id !== 'common')
  const activeSpecialBoosts = new Set([...selectedGrammarBoosts].filter((id) => (
    (id.startsWith('ko_') && selectedCategories.has('korean'))
    || (id.startsWith('en_') && selectedCategories.has('english'))
    || (id.startsWith('math_') && selectedCategories.has('math'))
  )))

  let usedFallback = false
  if (!rawMode && subjectOnly.length > 0 && !selectedCategories.has('common')) {
    let anyMatch = false
    outer: for (const para of paragraphs) {
      for (const w of extractWords(para)) {
        if (subjectOnly.some((c) => c.test(w.clean))) { anyMatch = true; break outer }
      }
    }
    if (!anyMatch) usedFallback = true
  }
  const effectiveCats = usedFallback ? [...activeCats, CATEGORIES.find((c) => c.id === 'common')] : activeCats

  const perPara = paragraphs.map((paraText, paraIdx) => {
    const figure = isFigureLine(paraText)
    const heading = preserveHeadings && !ignoredHeadings.has(paraIdx) && isHeadingLine(paraText, paraIdx, paragraphs)
    const lineState = rawMode
      ? 'auto'
      : neverBlankLines.has(paraIdx)
        ? 'never'
        : alwaysBlankLines.has(paraIdx)
          ? 'always'
          : heading
            ? 'heading'
            : 'auto'
    const words = extractWords(paraText)

    let candidates = []
    if (rawMode || lineState === 'never' || lineState === 'heading') {
      candidates = []
    } else if (figure) {
      candidates = []
    } else if (lineState === 'always') {
      candidates = words.filter((w) => LINE_BLANK_MATCH(w.clean)).map((w) => ({ ...w, category: 'line', style: 'full', forced: true }))
    } else {
      for (const w of words) {
        const cat = effectiveCats.find((c) => c.test(w.clean))
        const specialTypes = getSpecialTypes(w.clean)
        const boosted = [...specialTypes].some((type) => activeSpecialBoosts.has(type))
        if (cat || boosted) candidates.push({
          ...w,
          category: cat?.id || 'grammar',
          style: 'full',
          forced: false,
          boosted,
        })
      }
    }

    const alwaysSpans = (rawMode || figure || lineState === 'never' || lineState === 'heading') ? [] : findPhraseSpans(paraText, alwaysList).map((s) => ({ ...s, category: 'always', style: 'full', forced: true }))
    const neverSpans = findPhraseSpans(paraText, neverList)

    let pool = [...candidates, ...alwaysSpans].filter((s) => !neverSpans.some((n) => overlaps(s, n)))
    pool.sort((a, b) => (b.forced ? 1 : 0) - (a.forced ? 1 : 0) || a.start - b.start || (b.end - b.start) - (a.end - a.start))
    const kept = []
    for (const s of pool) {
      if (!kept.some((k) => overlaps(k, s))) kept.push(s)
    }
    kept.sort((a, b) => a.start - b.start)

    return { paraIdx, paraText, figure, heading, lineState, words, pool: kept, column: layout.lineColumns[paraIdx] || 0 }
  })

  const density = level.density
  const eligible = perPara.filter((p) => !p.figure && p.lineState !== 'never' && p.lineState !== 'heading')
  const totalWords = eligible.reduce((s, p) => s + p.words.length, 0)
  const forcedSpansByPara = new Map(eligible.map((p) => [p.paraIdx, p.pool.filter((s) => s.forced)]))
  const forcedCountTotal = [...forcedSpansByPara.values()].reduce((s, arr) => s + arr.length, 0)
  const boostedCandidateCount = eligible.reduce((sum, p) => sum + p.pool.filter((s) => s.boosted && !s.forced).length, 0)
  const targetBlanksTotal = Math.round(totalWords * density + boostedCandidateCount * density * 0.5)
  const remainingBudget = Math.max(0, targetBlanksTotal - forcedCountTotal)

  const totalWeighted = eligible.reduce((s, p) => s + p.words.length + p.pool.filter((span) => span.boosted && !span.forced).length * 0.5, 0) || 1
  const rawShares = eligible.map((p) => {
    const paragraphWeight = p.words.length + p.pool.filter((span) => span.boosted && !span.forced).length * 0.5
    return { paraIdx: p.paraIdx, share: (paragraphWeight / totalWeighted) * remainingBudget }
  })
  const floors = rawShares.map((r) => ({ ...r, floor: Math.floor(r.share) }))
  let usedBudget = floors.reduce((s, r) => s + r.floor, 0)
  let leftover = remainingBudget - usedBudget
  const byRemainder = [...floors].sort((a, b) => (b.share - b.floor) - (a.share - a.floor))
  const shareMap = new Map(floors.map((r) => [r.paraIdx, r.floor]))
  for (let i = 0; i < byRemainder.length && leftover > 0; i++, leftover--) {
    shareMap.set(byRemainder[i].paraIdx, shareMap.get(byRemainder[i].paraIdx) + 1)
  }

  const minGapChars = level.minGapWords * 3
  const chosenKeys = new Set()

  for (const p of perPara) {
    if (p.figure) {
      for (const s of p.pool) chosenKeys.add(spanKey(p.paraIdx, s.start))
      continue
    }
    if (p.lineState === 'never' || p.lineState === 'heading') continue
    const share = shareMap.get(p.paraIdx) || 0
    const acceptedSpans = p.pool.filter((span) => span.forced)
    for (const span of acceptedSpans) chosenKeys.add(spanKey(p.paraIdx, span.start))
    const rankedCandidates = p.pool
      .filter((span) => !span.forced)
      .map((span) => ({
        ...span,
        priority: stableWeightedPriority(`${p.paraIdx}:${span.start}:${span.clean}`, span.boosted ? 1.5 : 1),
      }))
      .sort((a, b) => a.priority - b.priority || a.start - b.start)
    let nonForcedAccepted = 0
    for (const s of rankedCandidates) {
      if (nonForcedAccepted >= share) break
      if (acceptedSpans.some((accepted) => spanDistance(accepted, s) < minGapChars)) continue
      chosenKeys.add(spanKey(p.paraIdx, s.start))
      acceptedSpans.push(s)
      nonForcedAccepted++
    }
  }

  if (!rawMode) {
    for (const k of manualInclude) chosenKeys.add(k)
    for (const k of manualExclude) chosenKeys.delete(k)
  }

  let seq = 0
  const renderParas = perPara.map((p) => {
    const blanks = p.pool
      .filter((s) => chosenKeys.has(spanKey(p.paraIdx, s.start)))
      .map((s) => ({ ...s, key: spanKey(p.paraIdx, s.start), seq: ++seq }))
    const unchosen = p.pool.filter((s) => !chosenKeys.has(spanKey(p.paraIdx, s.start)))
    return { ...p, blanks, unchosen }
  })

  const blankCount = renderParas.reduce((s, p) => s + p.blanks.length, 0)
  const answers = renderParas.flatMap((p) => p.blanks).sort((a, b) => a.seq - b.seq)
  const subjectLabel = usedFallback ? '공통(대체)' : effectiveCats.map((c) => c.label).join('·') || '공통'
  const specialLabel = SPECIAL_BOOSTS.filter((type) => activeSpecialBoosts.has(type.id)).map((type) => `${type.label}+50%`).join('·')
  const categoryLabel = rawMode ? '원문' : specialLabel ? `${subjectLabel} · ${specialLabel}` : subjectLabel

  return {
    paragraphs: renderParas,
    blankCount,
    answers,
    usedFallback,
    categoryLabel,
    visuals: visuals.map((visual) => ({ ...visual, excluded: excludedVisuals.has(visual.id) })),
    layout,
    printPage,
  }
}

function BlankField({ blank, studyMode, userAnswers, setUserAnswer, checked }) {
  const answerText = blank.clean

  if (studyMode === 'reveal') {
    return <span className="blank-reveal">{answerText}</span>
  }
  const current = userAnswers[blank.key] || ''
  const isCorrect = checked && current.trim() === answerText
  const isWrong = checked && current.trim() && current.trim() !== answerText
  return (
    <input
      className={`blank-input${isCorrect ? ' is-correct' : ''}${isWrong ? ' is-wrong' : ''}`}
      style={{ width: `${Math.max(answerText.length, 3) * 0.95}em` }}
      value={current}
      onChange={(e) => setUserAnswer(blank.key, e.target.value)}
      placeholder=""
    />
  )
}

function Paragraph({ p, studyMode, userAnswers, setUserAnswer, checked, editMode, toggleManual, cycleLineState, lineControlsEnabled }) {
  const stateClass = p.lineState === 'always' ? 'line-always' : p.lineState === 'never' ? 'line-never' : p.lineState === 'heading' ? 'line-heading' : ''
  const isEmpty = !p.paraText.trim()
  const canCycleLine = lineControlsEnabled && !isEmpty && !p.figure
  const lineTitle = p.lineState === 'always'
    ? `${p.paraIdx + 1}줄: 항상 빈칸 · 클릭하면 항상 남기기`
    : p.lineState === 'never'
      ? `${p.paraIdx + 1}줄: 항상 남기기 · 클릭하면 자동으로 전환`
      : p.lineState === 'heading'
        ? `${p.paraIdx + 1}줄: 제목·목차로 자동 보존 · 클릭하면 이 줄만 일반 텍스트로 전환`
      : `${p.paraIdx + 1}줄: 자동 · 클릭하면 줄 전체를 빈칸으로 전환`
  return (
    <div className={`ws-line${isEmpty ? ' ws-empty-line' : ''} ${stateClass}`}>
      {canCycleLine ? (
        <button
          className={`ws-line-num ws-line-action ${stateClass}`}
          onClick={() => cycleLineState(p.paraIdx)}
          title={lineTitle}
          aria-label={lineTitle}
        >
          {p.paraIdx + 1}
        </button>
      ) : (
        <span className="ws-line-num" title={p.figure ? '그림·표 설명 줄' : undefined}>{isEmpty ? '' : p.paraIdx + 1}</span>
      )}
      <div className="ws-line-content">
        {isEmpty ? (
          <span aria-hidden="true">&nbsp;</span>
        ) : p.figure ? (
          <div className="figure-box">
            <div className="figure-label">FIGURE · {p.paraText.replace(/^\[|\]$/g, '').slice(0, 2)}</div>
            <div className="figure-text">
              {renderSegments(p.paraText, p.blanks, p.unchosen, { studyMode, userAnswers, setUserAnswer, checked, editMode, toggleManual, paraIdx: p.paraIdx })}
            </div>
          </div>
        ) : (
          <p className={`ws-paragraph${p.heading ? ' ws-heading' : ''}`}>
            {renderSegments(p.paraText, p.blanks, p.unchosen, { studyMode, userAnswers, setUserAnswer, checked, editMode, toggleManual, paraIdx: p.paraIdx })}
          </p>
        )}
      </div>
    </div>
  )
}

function PageVisuals({ visuals, toggleVisual, interactive = true }) {
  if (!visuals.length) return null
  const shownVisuals = interactive ? visuals : visuals.filter((visual) => !visual.excluded)
  if (!shownVisuals.length) return null

  return (
    <div className="page-visuals">
      {shownVisuals.map((visual, index) => (
        <div key={visual.id} className={`page-visual-row${visual.excluded ? ' is-excluded' : ''}`}>
          <div className="page-visual-marker">도표 {visual.number || index + 1}</div>
          <div className="page-visual-content">
            {visual.excluded ? (
              <div className="page-visual-placeholder">미리보기와 출력에서 삭제됨</div>
            ) : (
              <img src={visual.src} alt={`원문에서 추출한 그림 또는 도표 ${index + 1}`} />
            )}
          </div>
          {interactive && (
            <button
              className={`visual-toggle-btn${visual.excluded ? ' include' : ' exclude'}`}
              onClick={() => toggleVisual(visual.id)}
            >
              {visual.excluded ? '다시 포함' : '삭제'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function WorksheetContent({ worksheet, paragraphProps, toggleVisual, interactive = true, paragraphs = worksheet.paragraphs, visuals = worksheet.visuals }) {
  const visualsByLine = new Map()
  const paragraphIndexes = new Set(paragraphs.map((p) => p.paraIdx))
  const placedVisualIds = new Set()
  for (const visual of visuals) {
    const lineIndex = visual.insertBeforeLine ?? worksheet.paragraphs.length
    if (!paragraphIndexes.has(lineIndex)) continue
    const grouped = visualsByLine.get(lineIndex) || []
    grouped.push(visual)
    visualsByLine.set(lineIndex, grouped)
    placedVisualIds.add(visual.id)
  }
  const trailingVisuals = visuals.filter((visual) => !placedVisualIds.has(visual.id))

  return (
    <>
      {paragraphs.map((p) => (
        <Fragment key={p.paraIdx}>
          <PageVisuals visuals={visualsByLine.get(p.paraIdx) || EMPTY_ARRAY} toggleVisual={toggleVisual} interactive={interactive} />
          <Paragraph p={p} {...paragraphProps} />
        </Fragment>
      ))}
      <PageVisuals visuals={trailingVisuals} toggleVisual={toggleVisual} interactive={interactive} />
    </>
  )
}

function buildOriginalPrintOverlays(worksheet, reveal) {
  if (reveal || !worksheet.layout.lineRuns) return []
  const overlays = []
  for (const paragraph of worksheet.paragraphs) {
    const runs = worksheet.layout.lineRuns[paragraph.paraIdx] || []
    for (const blank of paragraph.blanks) {
      const blankStart = blank.style === 'hint' ? Math.min(blank.start + 1, blank.end) : blank.start
      for (const run of runs) {
        const overlapStart = Math.max(blankStart, run.start)
        const overlapEnd = Math.min(blank.end, run.end)
        if (overlapStart >= overlapEnd || run.end <= run.start) continue
        const startRatio = (overlapStart - run.start) / (run.end - run.start)
        const endRatio = (overlapEnd - run.start) / (run.end - run.start)
        const horizontalPadding = run.height * 0.22
        const rawX = run.x + run.width * startRatio
        const rawWidth = Math.max(run.width * (endRatio - startRatio), run.height * 0.8)
        const x = Math.max(0, rawX - horizontalPadding)
        const top = Math.max(0, run.top - run.height * 0.18)
        overlays.push({
          key: `${paragraph.paraIdx}-${blank.start}-${run.start}`,
          x,
          top,
          width: Math.min(worksheet.layout.pageWidth - x, rawWidth + horizontalPadding * 2),
          height: Math.min(worksheet.layout.pageHeight - top, run.height * 1.45),
        })
      }
    }
  }
  return overlays
}

function OriginalPrintPage({ worksheet, studyMode }) {
  const { printPage, layout } = worksheet
  const blankOverlays = buildOriginalPrintOverlays(worksheet, studyMode === 'reveal')
  const removedVisuals = worksheet.visuals.filter((visual) => visual.excluded)
  if (!printPage) return null

  return (
    <div className="original-print-page" style={{ aspectRatio: `${printPage.width} / ${printPage.height}` }}>
      <img src={printPage.src} alt="원문 인쇄 페이지" />
      {blankOverlays.map((overlay) => (
        <span
          key={overlay.key}
          className="original-blank-overlay"
          style={{
            left: `${(overlay.x / layout.pageWidth) * 100}%`,
            top: `${(overlay.top / layout.pageHeight) * 100}%`,
            width: `${(overlay.width / layout.pageWidth) * 100}%`,
            height: `${(overlay.height / layout.pageHeight) * 100}%`,
          }}
        />
      ))}
      {removedVisuals.map((visual) => (
        <span
          key={`removed-${visual.id}`}
          className="original-removed-visual"
          style={{
            left: `${((visual.centerX - visual.sourceWidth / 2) / layout.pageWidth) * 100}%`,
            top: `${(visual.order / layout.pageHeight) * 100}%`,
            width: `${(visual.sourceWidth / layout.pageWidth) * 100}%`,
            height: `${(visual.sourceHeight / layout.pageHeight) * 100}%`,
          }}
        />
      ))}
    </div>
  )
}

function renderSegments(paraText, blanks, unchosen, ctx) {
  const marks = [
    ...blanks.map((b) => ({ ...b, kind: 'blank' })),
    ...(ctx.editMode ? unchosen.map((u) => ({ ...u, kind: 'candidate' })) : []),
  ].sort((a, b) => a.start - b.start)

  const nodes = []
  let cursor = 0
  marks.forEach((m, i) => {
    if (m.start > cursor) nodes.push(<span key={`t${i}`}>{paraText.slice(cursor, m.start)}</span>)
    const key = spanKey(ctx.paraIdx, m.start)
    if (m.kind === 'blank') {
      if (ctx.editMode) {
        nodes.push(
          <span
            key={`b${i}`}
            className={`blank-chip${m.style === 'hint' ? ' hint' : ''}`}
            title="클릭하면 빈칸에서 제외됩니다"
            onClick={() => ctx.toggleManual(key, 'exclude')}
          >
            {m.style === 'hint' ? `${m.clean[0]}___` : '● '.repeat(1) + m.clean.length + '자'}
          </span>,
        )
      } else if (m.style === 'hint') {
        const hint = m.clean[0]
        const rest = m.clean.slice(1)
        nodes.push(
          <span key={`b${i}`} className="blank-hint-wrap">
            <span className="blank-hint-char">{hint}</span>
            <BlankField
              blank={{ ...m, clean: rest }}
              studyMode={ctx.studyMode}
              userAnswers={ctx.userAnswers}
              setUserAnswer={ctx.setUserAnswer}
              checked={ctx.checked}
            />
          </span>,
        )
      } else {
        nodes.push(
          <BlankField
            key={`b${i}`}
            blank={m}
            studyMode={ctx.studyMode}
            userAnswers={ctx.userAnswers}
            setUserAnswer={ctx.setUserAnswer}
            checked={ctx.checked}
          />,
        )
      }
    } else {
      nodes.push(
        <span
          key={`c${i}`}
          className="candidate-chip"
          title="클릭하면 빈칸으로 추가됩니다"
          onClick={() => ctx.toggleManual(key, 'include')}
        >
          {m.clean}
        </span>,
      )
    }
    cursor = m.end
  })
  if (cursor < paraText.length) nodes.push(<span key="tail">{paraText.slice(cursor)}</span>)
  return nodes
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function blankFillText(b, reveal) {
  return reveal ? b.clean : (b.style === 'hint' ? `${b.clean[0]}${'_'.repeat(Math.max(b.clean.length - 1, 3))}` : '_'.repeat(Math.max(b.clean.length, 4)))
}

function includedVisualsAtLine(worksheet, lineIndex) {
  const lastLine = worksheet.paragraphs.length
  return worksheet.visuals.filter((visual) => {
    const visualLine = Math.min(Math.max(visual.insertBeforeLine ?? lastLine, 0), lastLine)
    return !visual.excluded && visualLine === lineIndex
  })
}

function buildHtmlVisuals(visuals) {
  return visuals
    .map((visual) => `<figure style="margin:20px 0;break-inside:avoid;"><img src="${visual.src}" alt="그림·도표 ${visual.number}" style="display:block;max-width:100%;height:auto;margin:auto;"></figure>`)
    .join('\n')
}

function buildPlainText(worksheets, title, reveal) {
  const lines = [title, '']
  worksheets.forEach((ws, pageIdx) => {
    if (worksheets.length > 1) {
      if (pageIdx > 0) lines.push('')
      lines.push(`── ${pageIdx + 1}페이지 ──`, '')
    }
    for (const p of ws.paragraphs) {
      includedVisualsAtLine(ws, p.paraIdx).forEach((visual) => lines.push(`[그림·도표 ${visual.number}]`))
      let text = p.paraText
      const blanksDesc = [...p.blanks].sort((a, b) => b.start - a.start)
      for (const b of blanksDesc) {
        text = text.slice(0, b.start) + blankFillText(b, reveal) + text.slice(b.end)
      }
      lines.push(p.figure ? `[FIGURE] ${text}` : text)
    }
    includedVisualsAtLine(ws, ws.paragraphs.length).forEach((visual) => lines.push(`[그림·도표 ${visual.number}]`))
  })
  return lines.join('\n')
}

function buildHtml(worksheets, title, reveal) {
  const body = worksheets.map((ws, pageIdx) => {
    const pageBody = ws.paragraphs.map((p) => {
      let text = p.paraText
      const blanksDesc = [...p.blanks].sort((a, b) => b.start - a.start)
      for (const b of blanksDesc) {
        const fill = reveal
          ? `<b style="color:#2f6b46">${b.clean}</b>`
          : `<span style="display:inline-block;border-bottom:1px solid #333;min-width:${Math.max(b.clean.length, 4)}ch;">&nbsp;</span>`
        text = text.slice(0, b.start) + fill + text.slice(b.end)
      }
      const line = !p.paraText.trim()
        ? '<div style="min-height:1.8em">&nbsp;</div>'
        : p.figure
        ? `<div style="border:1px dashed #999;padding:8px;margin:8px 0;">${text}</div>`
        : `<div style="min-height:1.8em">${text}</div>`
      return `${buildHtmlVisuals(includedVisualsAtLine(ws, p.paraIdx))}${line}`
    }).join('\n')
    const visualBody = buildHtmlVisuals(includedVisualsAtLine(ws, ws.paragraphs.length))
    const heading = worksheets.length > 1 ? `<h2>${pageIdx + 1}페이지</h2>` : ''
    return `${heading}${pageBody}${visualBody}`
  }).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:720px;margin:40px auto;line-height:1.8;"><h1>${title}</h1>${body}</body></html>`
}

export default function App() {
  const [sourcePages, setSourcePages] = useState([
    '조선의 제4대 임금인 세종은 1443년 훈민정음을 창제하고 1446년에 이를 반포하였다. 새로운 문자는 스물여덟 자로 이루어졌으며, 백성이 쉽게 익혀 쓸 수 있도록 만들어졌다.\n세종은 집현전을 중심으로 학문 연구를 장려하였다. 정인지와 신숙주 등 젊은 학자들이 이곳에서 역법과 음운을 연구하였고, 그 성과는 칠정산이라는 역법서로 정리되었다.\n과학 기술 분야에서도 성과가 컸다. 장영실은 자동으로 시각을 알리는 물시계인 자격루를 제작하였으며, 강우량을 재는 측우기는 1441년에 만들어져 전국의 관청에 보급되었다.',
  ])
  const [currentPage, setCurrentPage] = useState(0)
  const [level, setLevel] = useState(2)
  const [selectedCategories, setSelectedCategories] = useState(new Set(['common']))
  const [selectedGrammarBoosts, setSelectedGrammarBoosts] = useState(new Set())
  const [preserveHeadings, setPreserveHeadings] = useState(true)
  const [sourceVisualsByPage, setSourceVisualsByPage] = useState({})
  const [sourceLayoutsByPage, setSourceLayoutsByPage] = useState({})
  const [sourcePrintPagesByPage, setSourcePrintPagesByPage] = useState({})
  const [excludedVisualsByPage, setExcludedVisualsByPage] = useState({})
  const [alwaysBlankLinesByPage, setAlwaysBlankLinesByPage] = useState({})
  const [neverBlankLinesByPage, setNeverBlankLinesByPage] = useState({})
  const [ignoredHeadingsByPage, setIgnoredHeadingsByPage] = useState({})
  const [alwaysList, setAlwaysList] = useState([])
  const [neverList, setNeverList] = useState([])
  const [alwaysInput, setAlwaysInput] = useState('')
  const [neverInput, setNeverInput] = useState('')
  const [manualIncludeByPage, setManualIncludeByPage] = useState({})
  const [manualExcludeByPage, setManualExcludeByPage] = useState({})
  const [studyMode, setStudyMode] = useState('fill')
  const [userAnswersByPage, setUserAnswersByPage] = useState({})
  const [checkedByPage, setCheckedByPage] = useState({})
  const [exportFormat, setExportFormat] = useState('pdf')
  const [printMode, setPrintMode] = useState('original')
  const [qualityPrintFontSize, setQualityPrintFontSize] = useState(12)
  const [qualityPrintLayout, setQualityPrintLayout] = useState('portrait')
  const [worksheetTitle, setWorksheetTitle] = useState('빈칸 학습지')
  const [fileStatus, setFileStatus] = useState('')
  const [isPreparingPrint, setIsPreparingPrint] = useState(false)
  const fileInputRef = useRef(null)

  const levelObj = LEVELS.find((l) => l.id === level)
  const currentText = sourcePages[currentPage] || ''
  const alwaysBlankLines = alwaysBlankLinesByPage[currentPage] || EMPTY_SET
  const neverBlankLines = neverBlankLinesByPage[currentPage] || EMPTY_SET
  const ignoredHeadings = ignoredHeadingsByPage[currentPage] || EMPTY_SET
  const manualInclude = manualIncludeByPage[currentPage] || EMPTY_SET
  const manualExclude = manualExcludeByPage[currentPage] || EMPTY_SET
  const currentVisuals = sourceVisualsByPage[currentPage] || EMPTY_ARRAY
  const currentLayout = sourceLayoutsByPage[currentPage] || DEFAULT_LAYOUT
  const currentPrintPage = sourcePrintPagesByPage[currentPage] || null
  const excludedVisuals = excludedVisualsByPage[currentPage] || EMPTY_SET
  const userAnswers = userAnswersByPage[currentPage] || EMPTY_OBJ
  const checked = checkedByPage[currentPage] || false

  const worksheet = useMemo(
    () =>
      buildWorksheet({
        sourceText: currentText,
        level: levelObj,
        selectedCategories,
        selectedGrammarBoosts,
        preserveHeadings,
        ignoredHeadings,
        alwaysBlankLines,
        neverBlankLines,
        alwaysList,
        neverList,
        manualInclude,
        manualExclude,
        visuals: currentVisuals,
        excludedVisuals,
        layout: currentLayout,
        printPage: currentPrintPage,
      }),
    [currentText, levelObj, selectedCategories, selectedGrammarBoosts, preserveHeadings, ignoredHeadings, alwaysBlankLines, neverBlankLines, alwaysList, neverList, manualInclude, manualExclude, currentVisuals, excludedVisuals, currentLayout, currentPrintPage],
  )

  const allPageWorksheets = useMemo(
    () =>
      sourcePages.map((text, i) =>
        buildWorksheet({
          sourceText: text,
          level: levelObj,
          selectedCategories,
          selectedGrammarBoosts,
          preserveHeadings,
          ignoredHeadings: ignoredHeadingsByPage[i] || EMPTY_SET,
          alwaysBlankLines: alwaysBlankLinesByPage[i] || EMPTY_SET,
          neverBlankLines: neverBlankLinesByPage[i] || EMPTY_SET,
          alwaysList,
          neverList,
          manualInclude: manualIncludeByPage[i] || EMPTY_SET,
          manualExclude: manualExcludeByPage[i] || EMPTY_SET,
          visuals: sourceVisualsByPage[i] || [],
          excludedVisuals: excludedVisualsByPage[i] || EMPTY_SET,
          layout: sourceLayoutsByPage[i] || DEFAULT_LAYOUT,
          printPage: sourcePrintPagesByPage[i] || null,
        }),
      ),
    [sourcePages, levelObj, selectedCategories, selectedGrammarBoosts, preserveHeadings, ignoredHeadingsByPage, alwaysBlankLinesByPage, neverBlankLinesByPage, alwaysList, neverList, manualIncludeByPage, manualExcludeByPage, sourceVisualsByPage, excludedVisualsByPage, sourceLayoutsByPage, sourcePrintPagesByPage],
  )

  const totalBlankCount = allPageWorksheets.reduce((s, w) => s + w.blankCount, 0)
  const hasOriginalPrintPages = allPageWorksheets.length > 0 && allPageWorksheets.every((worksheetPage) => worksheetPage.printPage)
  const effectivePrintMode = printMode === 'original' && hasOriginalPrintPages ? 'original' : 'quality'
  const qualityPrintLayoutObj = QUALITY_PRINT_LAYOUTS.find((layoutOption) => layoutOption.id === qualityPrintLayout)
  const totalVisualCount = Object.values(sourceVisualsByPage).reduce((sum, visuals) => sum + visuals.length, 0)
  const excludedVisualCount = Object.entries(sourceVisualsByPage).reduce(
    (sum, [page, visuals]) => sum + visuals.filter((visual) => excludedVisualsByPage[page]?.has(visual.id)).length,
    0,
  )
  const allVisualsExcluded = totalVisualCount > 0 && excludedVisualCount === totalVisualCount

  const writtenCount = Object.values(userAnswers).filter((v) => v && v.trim()).length
  const correctCount = worksheet.answers.filter((a) => (userAnswers[a.key] || '').trim() === a.clean).length

  function toggleCategory(id) {
    setSelectedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSpecialBoost(id) {
    setSelectedGrammarBoosts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function cycleLineState(idx) {
    const isAlways = alwaysBlankLines.has(idx)
    const isNever = neverBlankLines.has(idx)
    const isAutoHeading = worksheet.paragraphs[idx]?.lineState === 'heading'

    if (isAutoHeading) {
      setIgnoredHeadingsByPage((prev) => ({ ...prev, [currentPage]: new Set(prev[currentPage] || []).add(idx) }))
      return
    }
    if (isAlways) {
      setAlwaysBlankLinesByPage((prev) => {
        const next = new Set(prev[currentPage] || [])
        next.delete(idx)
        return { ...prev, [currentPage]: next }
      })
      setNeverBlankLinesByPage((prev) => ({ ...prev, [currentPage]: new Set(prev[currentPage] || []).add(idx) }))
      return
    }
    if (isNever) {
      setNeverBlankLinesByPage((prev) => {
        const next = new Set(prev[currentPage] || [])
        next.delete(idx)
        return { ...prev, [currentPage]: next }
      })
      setIgnoredHeadingsByPage((prev) => {
        const next = new Set(prev[currentPage] || [])
        next.delete(idx)
        return { ...prev, [currentPage]: next }
      })
      return
    }
    setAlwaysBlankLinesByPage((prev) => ({ ...prev, [currentPage]: new Set(prev[currentPage] || []).add(idx) }))
  }

  function toggleVisual(visualId) {
    setExcludedVisualsByPage((prev) => {
      const next = new Set(prev[currentPage] || [])
      if (next.has(visualId)) next.delete(visualId)
      else next.add(visualId)
      return { ...prev, [currentPage]: next }
    })
  }

  function toggleAllVisuals() {
    if (allVisualsExcluded) {
      setExcludedVisualsByPage(Object.fromEntries(Object.keys(sourceVisualsByPage).map((page) => [page, new Set()])))
      return
    }
    setExcludedVisualsByPage(Object.fromEntries(
      Object.entries(sourceVisualsByPage).map(([page, visuals]) => [page, new Set(visuals.map((visual) => visual.id))]),
    ))
  }

  function setUserAnswer(key, val) {
    setUserAnswersByPage((prev) => ({ ...prev, [currentPage]: { ...(prev[currentPage] || {}), [key]: val } }))
  }

  function toggleManual(key, kind) {
    if (kind === 'exclude') {
      setManualExcludeByPage((prev) => ({ ...prev, [currentPage]: new Set(prev[currentPage] || []).add(key) }))
      setManualIncludeByPage((prev) => {
        const cur = prev[currentPage]
        if (!cur || !cur.has(key)) return prev
        const next = new Set(cur)
        next.delete(key)
        return { ...prev, [currentPage]: next }
      })
    } else {
      setManualIncludeByPage((prev) => ({ ...prev, [currentPage]: new Set(prev[currentPage] || []).add(key) }))
      setManualExcludeByPage((prev) => {
        const cur = prev[currentPage]
        if (!cur || !cur.has(key)) return prev
        const next = new Set(cur)
        next.delete(key)
        return { ...prev, [currentPage]: next }
      })
    }
  }

  function resetPageState() {
    setAlwaysBlankLinesByPage({})
    setNeverBlankLinesByPage({})
    setIgnoredHeadingsByPage({})
    setManualIncludeByPage({})
    setManualExcludeByPage({})
    setUserAnswersByPage({})
    setCheckedByPage({})
    setExcludedVisualsByPage({})
  }

  async function loadFile(file) {
    if (!file) return
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      setFileStatus('PDF에서 텍스트와 그림·도표를 추출하는 중…')
      try {
        const { pages, visualsByPage, layoutsByPage, printPagesByPage } = await extractPdfPages(file)
        resetPageState()
        setSourceVisualsByPage(visualsByPage)
        setSourceLayoutsByPage(layoutsByPage)
        setSourcePrintPagesByPage(printPagesByPage)
        setSourcePages(pages.length ? pages : [''])
        setCurrentPage(0)
        setFileStatus('')
      } catch {
        setFileStatus('PDF에서 텍스트와 그림·도표를 추출하지 못했습니다.')
      }
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      resetPageState()
      setSourceVisualsByPage({})
      setSourceLayoutsByPage({})
      setSourcePrintPagesByPage({})
      setSourcePages([String(reader.result || '')])
      setCurrentPage(0)
    }
    reader.readAsText(file)
  }

  function handleFile(e) {
    const file = e.target.files?.[0]
    loadFile(file)
    e.target.value = ''
  }

  function handleDrop(e) {
    e.preventDefault()
    loadFile(e.dataTransfer.files?.[0])
  }

  function addAlways() {
    if (!alwaysInput.trim()) return
    setAlwaysList((p) => [...p, alwaysInput.trim()])
    setAlwaysInput('')
  }
  function addNever() {
    if (!neverInput.trim()) return
    setNeverList((p) => [...p, neverInput.trim()])
    setNeverInput('')
  }

  function regenerate() {
    setManualIncludeByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setManualExcludeByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setAlwaysBlankLinesByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setNeverBlankLinesByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setIgnoredHeadingsByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setExcludedVisualsByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setUserAnswersByPage((prev) => ({ ...prev, [currentPage]: {} }))
    setCheckedByPage((prev) => ({ ...prev, [currentPage]: false }))
  }

  async function preparePrint() {
    if (isPreparingPrint) return
    setIsPreparingPrint(true)
    try {
      const printSources = effectivePrintMode === 'original'
        ? allPageWorksheets.map((worksheetPage) => worksheetPage.printPage?.src).filter(Boolean)
        : allPageWorksheets.flatMap((worksheetPage) => worksheetPage.visuals.filter((visual) => !visual.excluded).map((visual) => visual.src))
      await Promise.all(printSources.map((src) => new Promise((resolve) => {
        const image = new Image()
        image.onload = resolve
        image.onerror = resolve
        image.src = src
        if (image.decode) image.decode().then(resolve, resolve)
      })))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      window.print()
    } finally {
      setIsPreparingPrint(false)
    }
  }

  async function handleDownload() {
    if (exportFormat === 'pdf') {
      await preparePrint()
      return
    }
    const reveal = studyMode === 'reveal'
    if (exportFormat === 'txt') downloadFile(`${worksheetTitle}.txt`, buildPlainText(allPageWorksheets, worksheetTitle, reveal), 'text/plain;charset=utf-8')
    else if (exportFormat === 'md') downloadFile(`${worksheetTitle}.md`, `# ${worksheetTitle}\n\n` + buildPlainText(allPageWorksheets, '', reveal), 'text/markdown;charset=utf-8')
    else if (exportFormat === 'html') downloadFile(`${worksheetTitle}.html`, buildHtml(allPageWorksheets, worksheetTitle, reveal), 'text/html;charset=utf-8')
    else if (exportFormat === 'word') downloadFile(`${worksheetTitle}.doc`, buildHtml(allPageWorksheets, worksheetTitle, reveal), 'application/msword;charset=utf-8')
  }

  const editMode = studyMode === 'edit'

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">빈칸 학습지 생성기</span>
        <span className="brand-sub">지문을 넣으면 핵심 내용을 골라 빈칸으로 재가공합니다</span>
        <span className="version-tag">v{pkg.version} · 제작자 yunjunseop</span>
      </header>

      <main className="workspace">
        <section className="panel source-panel">
          <div className="panel-head">
            <span><span className="panel-num">01</span> 가공 전 자료</span>
            <span className="meta">
              {currentText.length}자 · {currentText.split(/\n+/).filter((l) => l.trim()).length}줄
              {sourcePages.length > 1 ? ` · ${currentPage + 1}/${sourcePages.length}페이지` : ''}
              {currentLayout.columnCount === 2 ? ' · 2단 인식' : ''}
            </span>
          </div>
          {sourcePages.length > 1 && (
            <div className="page-select-row">
              <span className="page-select-label">페이지</span>
              {sourcePages.map((_, i) => (
                <button
                  key={i}
                  className={`page-chip${currentPage === i ? ' active' : ''}`}
                  onClick={() => setCurrentPage(i)}
                  title={`원본 ${i + 1}페이지 보기`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          <div
            className="dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            <p className="dz-title">여기로 파일을 끌어다 놓으세요</p>
            <p className="dz-sub">또는 클릭해서 파일 선택 · 아래 칸에 직접 붙여넣기</p>
            <p className="dz-sub">PDF·TXT·MD·HTML 문서를 놓으면 원문의 줄바꿈과 표 간격을 유지합니다 (PDF 그림·도표 포함)</p>
            {fileStatus && <p className="dz-status">{fileStatus}</p>}
            <input ref={fileInputRef} type="file" accept=".txt,.md,.html,.pdf,application/pdf" hidden onChange={handleFile} />
          </div>
          <textarea
            className="source-textarea"
            value={currentText}
            onChange={(e) => setSourcePages((prev) => prev.map((t, i) => (i === currentPage ? e.target.value : t)))}
            placeholder="여기에 지문을 붙여넣으세요…"
          />
        </section>

        <section className="panel worksheet-panel">
          <div className="panel-head">
            <span><span className="panel-num">02</span> 빈칸 학습지 미리보기</span>
            <span className="meta">빈칸 {worksheet.blankCount} · 작성 {writtenCount} · 정답 {checked ? correctCount : 0}</span>
          </div>

          <div className="worksheet-toolbar">
            <div className="mode-tabs">
              {[
                ['fill', '채워쓰기'],
                ['reveal', '정답 공개'],
                ['edit', '빈칸 편집'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={`tab-btn${studyMode === id ? ' active' : ''}`}
                  onClick={() => setStudyMode(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              className="check-btn"
              disabled={studyMode === 'reveal' || studyMode === 'edit'}
              onClick={() => setCheckedByPage((prev) => ({ ...prev, [currentPage]: true }))}
            >
              정답 확인
            </button>
            {totalVisualCount > 0 && (
              <button className="visual-all-btn" onClick={toggleAllVisuals}>
                {allVisualsExcluded ? '그림·도표 모두 다시 포함' : `그림·도표 모두 제거 (${totalVisualCount})`}
              </button>
            )}
            <button className="print-btn" onClick={preparePrint} disabled={isPreparingPrint}>
              {isPreparingPrint ? '인쇄 준비 중…' : effectivePrintMode === 'original' ? '원문 형식 인쇄' : '가독성 우선 인쇄'}
            </button>
          </div>
          <div className="line-control-guide">
            줄 번호 클릭: <span className="guide-auto">자동</span> → <span className="guide-always">항상 빈칸</span> → <span className="guide-never">항상 남기기</span> · <span className="guide-heading">제목·목차 자동 보존은 해당 줄 번호를 눌러 개별 해제</span>
          </div>
          <div className="print-format-note">
            {effectivePrintMode === 'original'
              ? '원문 형식 인쇄: 원문의 글자 크기·단 구성·그림·표 위치와 페이지 수를 유지합니다. 원본 위에 빈칸을 덮으므로 일부 글자가 미세하게 남을 수 있습니다.'
              : `가독성 우선 인쇄: ${qualityPrintLayoutObj.label}, ${qualityPrintFontSize}pt로 다시 조판합니다. 원문과 페이지 수·줄바꿈은 달라질 수 있습니다.`}
          </div>

          {worksheet.usedFallback && (
            <div className="fallback-note">선택한 과목에서 후보를 찾지 못해 공통 규칙으로 대체했습니다.</div>
          )}

          <div className="worksheet-title-row">
            <input className="title-input" value={worksheetTitle} onChange={(e) => setWorksheetTitle(e.target.value)} />
            <span className="title-meta">빈칸 {worksheet.blankCount}개 · {worksheet.categoryLabel} · L{level} {levelObj.name}</span>
          </div>
          <div className="name-row">이름 <span className="name-line" /></div>

          <div id="printable" className="worksheet-body manuscript">
            <WorksheetContent
              worksheet={worksheet}
              toggleVisual={toggleVisual}
              paragraphProps={{
                studyMode,
                userAnswers,
                setUserAnswer,
                checked,
                editMode,
                toggleManual,
                cycleLineState,
                lineControlsEnabled: level !== 0,
              }}
            />
            {worksheet.paragraphs.length === 0 && <p className="empty-msg">왼쪽에 지문을 입력하면 학습지가 생성됩니다.</p>}
          </div>

          <div
            className={`print-all-pages ${effectivePrintMode}-print${effectivePrintMode === 'quality' ? ` quality-${qualityPrintLayout}` : ''}`}
            style={effectivePrintMode === 'quality' ? { '--quality-print-font-size': `${qualityPrintFontSize}pt` } : undefined}
          >
            {effectivePrintMode === 'quality' && (
              <>
                <div className="worksheet-title-row">
                  <span className="title-input">{worksheetTitle}</span>
                  <span className="title-meta">
                    빈칸 {totalBlankCount}개 · {allPageWorksheets[0]?.categoryLabel} · L{level} {levelObj.name}
                    {sourcePages.length > 1 ? ` · ${sourcePages.length}페이지` : ''}
                  </span>
                </div>
                <div className="name-row">이름 <span className="name-line" /></div>
              </>
            )}
            {allPageWorksheets.map((ws, pageIdx) => (
              <div key={pageIdx} className={`print-page-block ${effectivePrintMode}-layout`}>
                {effectivePrintMode === 'original' ? (
                  <OriginalPrintPage worksheet={ws} studyMode={studyMode} />
                ) : (
                  <WorksheetContent
                    worksheet={ws}
                    toggleVisual={NOOP}
                    interactive={false}
                    paragraphProps={{
                      studyMode,
                      userAnswers: EMPTY_OBJ,
                      setUserAnswer: NOOP,
                      checked: false,
                      editMode: false,
                      toggleManual: NOOP,
                      cycleLineState: NOOP,
                      lineControlsEnabled: false,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      <section className="controls-grid">
        <div className="control-card">
          <h3>빈칸 인식 레벨</h3>
          <div className="level-row">
            {LEVELS.map((l) => (
              <button key={l.id} className={`level-btn${level === l.id ? ' active' : ''}`} onClick={() => setLevel(l.id)}>
                <span className="level-id">{l.label}</span>
                <span className="level-name">{l.name}</span>
                <span className="level-pct">{l.densityLabel || `${Math.round(l.density * 100)}%`}</span>
              </button>
            ))}
          </div>

          <h3>특화 빈칸 생성</h3>
          <div className="chip-row">
            {CATEGORIES.filter((c) => c.group === 'subject').map((c) => (
              <button key={c.id} className={`chip${selectedCategories.has(c.id) ? ' selected' : ''}`} onClick={() => toggleCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          <div className="chip-row">
            <span className="chip-row-label">본문 구조</span>
            <button
              className={`chip${preserveHeadings ? ' selected' : ''}`}
              onClick={() => setPreserveHeadings((value) => !value)}
              title="제목, 주제, 소제목, 단원명과 목차형 줄을 자동으로 남깁니다. 미리보기 줄 번호로 개별 해제할 수 있습니다"
            >
              제목·목차 자동 남기기
            </button>
          </div>
          {selectedCategories.has('korean') && (
            <div className="special-option-panel">
              <div className="special-option-title">국어 9품사</div>
              <div className="chip-row">
                {KOREAN_POS_BOOSTS.map((type) => (
                  <button
                    key={type.id}
                    className={`chip${selectedGrammarBoosts.has(type.id) ? ' selected' : ''}`}
                    onClick={() => toggleSpecialBoost(type.id)}
                    title={`${type.label}로 인식된 단어의 빈칸 빈도를 50% 높입니다`}
                  >
                    {type.label} +50%
                  </button>
                ))}
              </div>
              <p className="boost-note">한국어 문장 형태를 기준으로 9품사를 간이 분석합니다.</p>
            </div>
          )}
          {selectedCategories.has('english') && (
            <div className="special-option-panel">
              <div className="special-option-title">영어 8품사</div>
              <div className="chip-row">
                {ENGLISH_POS_BOOSTS.map((type) => (
                  <button
                    key={type.id}
                    className={`chip${selectedGrammarBoosts.has(type.id) ? ' selected' : ''}`}
                    onClick={() => toggleSpecialBoost(type.id)}
                    title={`${type.label}로 인식된 영어 단어의 빈칸 빈도를 50% 높입니다`}
                  >
                    {type.label} +50%
                  </button>
                ))}
              </div>
            </div>
          )}
          {selectedCategories.has('math') && (
            <div className="special-option-panel">
              <div className="special-option-title">수식 특화 빈칸</div>
              <div className="chip-row">
                {MATH_BOOSTS.map((type) => (
                  <button
                    key={type.id}
                    className={`chip${selectedGrammarBoosts.has(type.id) ? ' selected' : ''}`}
                    onClick={() => toggleSpecialBoost(type.id)}
                    title={`${type.label}에 해당하는 수식의 빈칸 빈도를 50% 높입니다`}
                  >
                    {type.label} +50%
                  </button>
                ))}
              </div>
            </div>
          )}
          {!selectedCategories.has('korean') && !selectedCategories.has('english') && !selectedCategories.has('math') && (
            <p className="boost-note">국어·영어·수학을 선택하면 과목별 세부 빈칸 설정이 표시됩니다.</p>
          )}

        </div>

        <div className="control-card">
          <h3>내려받을 파일 형식</h3>
          <div className="chip-row">
            {FORMATS.map((f) => (
              <button key={f.id} className={`chip${exportFormat === f.id ? ' selected' : ''}`} onClick={() => setExportFormat(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="print-settings">
            <div className="print-setting-label">인쇄 방식</div>
            <div className="print-mode-grid">
              <button
                className={`print-mode-btn${effectivePrintMode === 'original' ? ' active' : ''}`}
                onClick={() => setPrintMode('original')}
                disabled={!hasOriginalPrintPages}
              >
                <strong>원문 형식</strong>
                <span>원래 배치와 페이지 수 유지</span>
              </button>
              <button
                className={`print-mode-btn${effectivePrintMode === 'quality' ? ' active' : ''}`}
                onClick={() => setPrintMode('quality')}
              >
                <strong>가독성 우선</strong>
                <span>원문 단 구성과 관계없이 한 단으로 다시 조판</span>
              </button>
            </div>
            {!hasOriginalPrintPages && <p className="print-setting-help">PDF 원본 페이지가 없으므로 가독성 우선 인쇄를 사용합니다.</p>}
            {effectivePrintMode === 'quality' && (
              <>
                <div className="quality-layout-setting">
                  <div className="print-setting-label">용지 구성</div>
                  <div className="print-layout-grid">
                    {QUALITY_PRINT_LAYOUTS.map((layoutOption) => (
                      <button
                        key={layoutOption.id}
                        className={`print-mode-btn${qualityPrintLayout === layoutOption.id ? ' active' : ''}`}
                        onClick={() => setQualityPrintLayout(layoutOption.id)}
                      >
                        <strong>{layoutOption.label}</strong>
                        <span>{layoutOption.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <label className="font-size-control">
                  <span>인쇄 글자 크기</span>
                  <input
                    type="range"
                    min="9"
                    max="20"
                    step="0.5"
                    value={qualityPrintFontSize}
                    onChange={(event) => setQualityPrintFontSize(Number(event.target.value))}
                  />
                  <output>{qualityPrintFontSize}pt</output>
                </label>
                <p className="duplex-note">양면 인쇄 호환 · 인쇄 창에서 ‘양면 인쇄’를 선택하면 페이지 순서대로 앞뒤 출력됩니다.</p>
              </>
            )}
          </div>
          <button className="download-btn" onClick={handleDownload}>내려받기</button>
          <div className="row-actions">
            <button className="ghost-btn" onClick={regenerate}>다시 생성</button>
            <button className="ghost-btn" onClick={() => alert('현재 설정이 저장되었습니다. (브라우저 세션 내 유지)')}>설정 저장</button>
          </div>
        </div>

        <div className="control-card full phrase-card">
          <div className="phrase-col always">
            <h4>항상 빈칸으로 가리기</h4>
            <p className="phrase-desc">입력한 어구는 지문에서 지워지고 빈칸이 됩니다.</p>
            <div className="phrase-input-row">
              <input value={alwaysInput} onChange={(e) => setAlwaysInput(e.target.value)} placeholder="예: 훈민정음, 세종, 1443년" onKeyDown={(e) => e.key === 'Enter' && addAlways()} />
              <button onClick={addAlways}>가리기 추가</button>
            </div>
            <div className="tag-row">
              {alwaysList.map((t, i) => (
                <span key={i} className="tag tag-always" onClick={() => setAlwaysList((p) => p.filter((_, idx) => idx !== i))}>{t} ×</span>
              ))}
            </div>
            <p className="phrase-line-guide">줄 전체 지정은 위 미리보기의 줄 번호를 클릭하세요.</p>
          </div>
          <div className="phrase-col never">
            <h4>항상 그대로 남기기</h4>
            <p className="phrase-desc">절대 빈칸이 되지 않습니다.</p>
            <div className="phrase-input-row">
              <input value={neverInput} onChange={(e) => setNeverInput(e.target.value)} placeholder="예: 조선, 임금" onKeyDown={(e) => e.key === 'Enter' && addNever()} />
              <button onClick={addNever}>남기기 추가</button>
            </div>
            <div className="tag-row">
              {neverList.map((t, i) => (
                <span key={i} className="tag tag-never" onClick={() => setNeverList((p) => p.filter((_, idx) => idx !== i))}>{t} ×</span>
              ))}
            </div>
            <p className="phrase-line-guide">줄 전체 지정은 위 미리보기의 줄 번호를 클릭하세요.</p>
          </div>
        </div>
      </section>

      <footer className="footer-note">줄 번호를 클릭해 자동·항상 빈칸·항상 남기기를 전환하고, 그림·도표는 항목 옆 버튼으로 포함 여부를 선택할 수 있습니다.</footer>
    </div>
  )
}
