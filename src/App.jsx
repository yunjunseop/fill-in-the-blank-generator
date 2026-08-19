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
    const viewport = page.getViewport({ scale: 2 })
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
  const coordinates = page.imageCoordinates || []
  const visuals = []
  const seen = new Set()

  for (let i = 0; i + 5 < coordinates.length && visuals.length < 12; i += 6) {
    const xs = [coordinates[i], coordinates[i + 2], coordinates[i + 4]]
    const ys = [coordinates[i + 1], coordinates[i + 3], coordinates[i + 5]]
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
  }

  const orderedVisuals = visuals
    .sort((a, b) => a.order - b.order)
    .map((visual, index) => ({ ...visual, id: `pdf-visual-${index + 1}`, number: index + 1 }))
  return {
    visuals: orderedVisuals,
    printPage: {
      src: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
    },
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
  { id: 1, label: 'L1', name: '가볍게', density: 0.06, minGapWords: 6 },
  { id: 2, label: 'L2', name: '기본', density: 0.1, minGapWords: 5 },
  { id: 3, label: 'L3', name: '집중', density: 0.16, minGapWords: 4 },
  { id: 4, label: 'L4', name: '심화', density: 0.22, minGapWords: 3 },
]

const HANGUL = /[가-힣]/
const LOGIC_WORDS = ['그러나', '하지만', '따라서', '그러므로', '또한', '그리고', '즉', '왜냐하면', '반면', '결국', '그래서', '한편', '더구나', '게다가', '그럼에도']
const COMMON_STOP = new Set(['것', '수', '등', '때', '이후', '통해', '대한', '위해', '따라', '경우', '정도', '때문'])
const ENGLISH_STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'with', 'as', 'by', 'this', 'that', 'it', 'be', 'have', 'has', 'had'])
const PARTICLES = ['은', '는', '이', '가', '의', '을', '를', '과', '와']

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
  { id: 'math', label: '수학', group: 'subject', test: (c) => /^\d+(\.\d+)?%?$/.test(c) || /(식|정리|함수|공식)$/.test(c) || /[×÷√±]/.test(c) },
  { id: 'society', label: '사회', group: 'subject', test: (c) => /^\d{3,4}년?$/.test(c) || /(법|조약|운동|제도|사건|왕조|전쟁|협정|개혁)$/.test(c) },
  { id: 'science', label: '과학', group: 'subject', test: (c) => /^\d+(\.\d+)?(cm|mm|km|kg|g|m|℃|%|초|분|시간|Hz|N|J)$/.test(c) || /(현상|물질|에너지|원소|세포|반응|작용)$/.test(c) },
  { id: 'define', label: '정의·개념어', group: 'recommend', test: (c) => c.length >= 3 && /(이란|정의|개념|법칙|원리|이론)$/.test(c) },
  { id: 'timeline', label: '연표·수치', group: 'recommend', test: (c) => /^\d{1,4}(년|월|일)?$/.test(c) },
  {
    id: 'person', label: '인물·고유명사', group: 'recommend', test: (c) => {
      if (!HANGUL.test(c) || c.length < 3 || c.length > 6) return false
      const root = stripParticle(c)
      return root.length >= 2 && root.length <= 4 && !COMMON_STOP.has(root)
    },
  },
  { id: 'logic', label: '논리 연결어', group: 'recommend', test: (c) => LOGIC_WORDS.includes(c) },
  { id: 'firstchar', label: '첫 글자만 남기기', group: 'recommend', style: 'hint', test: (c) => HANGUL.test(c) && c.length >= 4 },
]

const FORMATS = [
  { id: 'pdf', label: 'PDF·인쇄' },
  { id: 'word', label: 'Word' },
  { id: 'html', label: 'HTML' },
  { id: 'txt', label: 'TXT' },
  { id: 'md', label: 'MD' },
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

function spanKey(paraIdx, start) {
  return `${paraIdx}:${start}`
}

const LINE_BLANK_MATCH = (c) => c.length >= 2 && (HANGUL.test(c) || /\d/.test(c))

function buildWorksheet({ sourceText, level, selectedCategories, alwaysBlankLines, neverBlankLines, alwaysList, neverList, manualInclude, manualExclude, visuals = [], excludedVisuals = EMPTY_SET, layout = DEFAULT_LAYOUT, printPage = null }) {
  const paragraphs = sourceText
    ? sourceText.replace(/\r\n?/g, '\n').split('\n')
    : []
  const rawMode = level.id === 0
  const activeCats = CATEGORIES.filter((c) => selectedCategories.has(c.id))
  const subjectOnly = activeCats.filter((c) => c.group === 'subject' && c.id !== 'common')

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
    const lineState = rawMode ? 'auto' : neverBlankLines.has(paraIdx) ? 'never' : alwaysBlankLines.has(paraIdx) ? 'always' : 'auto'
    const words = extractWords(paraText)

    let candidates = []
    if (rawMode || lineState === 'never') {
      candidates = []
    } else if (figure) {
      candidates = []
    } else if (lineState === 'always') {
      candidates = words.filter((w) => LINE_BLANK_MATCH(w.clean)).map((w) => ({ ...w, category: 'line', style: 'full', forced: true }))
    } else {
      for (const w of words) {
        const cat = effectiveCats.find((c) => c.test(w.clean))
        if (cat) candidates.push({ ...w, category: cat.id, style: cat.style || 'full', forced: false })
      }
    }

    const alwaysSpans = (rawMode || figure || lineState === 'never') ? [] : findPhraseSpans(paraText, alwaysList).map((s) => ({ ...s, category: 'always', style: 'full', forced: true }))
    const neverSpans = findPhraseSpans(paraText, neverList)

    let pool = [...candidates, ...alwaysSpans].filter((s) => !neverSpans.some((n) => overlaps(s, n)))
    pool.sort((a, b) => (b.forced ? 1 : 0) - (a.forced ? 1 : 0) || a.start - b.start || (b.end - b.start) - (a.end - a.start))
    const kept = []
    for (const s of pool) {
      if (!kept.some((k) => overlaps(k, s))) kept.push(s)
    }
    kept.sort((a, b) => a.start - b.start)

    return { paraIdx, paraText, figure, lineState, words, pool: kept, column: layout.lineColumns[paraIdx] || 0 }
  })

  const density = level.density
  const eligible = perPara.filter((p) => !p.figure && p.lineState !== 'never')
  const totalWords = eligible.reduce((s, p) => s + p.words.length, 0)
  const forcedSpansByPara = new Map(eligible.map((p) => [p.paraIdx, p.pool.filter((s) => s.forced)]))
  const forcedCountTotal = [...forcedSpansByPara.values()].reduce((s, arr) => s + arr.length, 0)
  const targetBlanksTotal = Math.round(totalWords * density)
  const remainingBudget = Math.max(0, targetBlanksTotal - forcedCountTotal)

  const totalWeighted = eligible.reduce((s, p) => s + p.words.length, 0) || 1
  const rawShares = eligible.map((p) => ({ paraIdx: p.paraIdx, share: (p.words.length / totalWeighted) * remainingBudget }))
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
    if (p.lineState === 'never') continue
    const share = shareMap.get(p.paraIdx) || 0
    let nonForcedAccepted = 0
    let lastEnd = -Infinity
    for (const s of p.pool) {
      if (s.forced) {
        chosenKeys.add(spanKey(p.paraIdx, s.start))
        lastEnd = s.end
        continue
      }
      if (nonForcedAccepted >= share) continue
      if (s.start - lastEnd < minGapChars) continue
      chosenKeys.add(spanKey(p.paraIdx, s.start))
      nonForcedAccepted++
      lastEnd = s.end
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
  const categoryLabel = rawMode ? '원문' : usedFallback ? '공통(대체)' : effectiveCats.map((c) => c.label).join('·') || '공통'

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
  const stateClass = p.lineState === 'always' ? 'line-always' : p.lineState === 'never' ? 'line-never' : ''
  const isEmpty = !p.paraText.trim()
  const canCycleLine = lineControlsEnabled && !isEmpty && !p.figure
  const lineTitle = p.lineState === 'always'
    ? `${p.paraIdx + 1}줄: 항상 빈칸 · 클릭하면 항상 남기기`
    : p.lineState === 'never'
      ? `${p.paraIdx + 1}줄: 항상 남기기 · 클릭하면 자동으로 전환`
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
          <p className="ws-paragraph">
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

function PrintWorksheetContent({ worksheet, paragraphProps }) {
  if (worksheet.layout.columnCount !== 2) {
    return <WorksheetContent worksheet={worksheet} paragraphProps={paragraphProps} toggleVisual={NOOP} interactive={false} />
  }

  const columnParagraphs = worksheet.paragraphs.filter((p) => p.column === 1 || p.column === 2)
  const firstColumnLine = columnParagraphs.length ? Math.min(...columnParagraphs.map((p) => p.paraIdx)) : 0
  const lastColumnLine = columnParagraphs.length ? Math.max(...columnParagraphs.map((p) => p.paraIdx)) : worksheet.paragraphs.length
  const headerParagraphs = worksheet.paragraphs.filter((p) => p.column === 0 && p.paraIdx < firstColumnLine)
  const footerParagraphs = worksheet.paragraphs.filter((p) => p.column === 0 && p.paraIdx > lastColumnLine)
  const middleFullParagraphs = worksheet.paragraphs.filter((p) => p.column === 0 && p.paraIdx >= firstColumnLine && p.paraIdx <= lastColumnLine)
  const headerVisuals = worksheet.visuals.filter((visual) => visual.column === 0 && visual.insertBeforeLine <= firstColumnLine)
  const footerVisuals = worksheet.visuals.filter((visual) => visual.column === 0 && visual.insertBeforeLine > firstColumnLine)

  return (
    <>
      <WorksheetContent worksheet={worksheet} paragraphs={headerParagraphs} visuals={headerVisuals} paragraphProps={paragraphProps} toggleVisual={NOOP} interactive={false} />
      <div className="print-two-columns">
        <div className="print-column">
          <WorksheetContent
            worksheet={worksheet}
            paragraphs={worksheet.paragraphs.filter((p) => p.column === 1)}
            visuals={worksheet.visuals.filter((visual) => visual.column === 1)}
            paragraphProps={paragraphProps}
            toggleVisual={NOOP}
            interactive={false}
          />
        </div>
        <div className="print-column">
          <WorksheetContent
            worksheet={worksheet}
            paragraphs={worksheet.paragraphs.filter((p) => p.column === 2)}
            visuals={worksheet.visuals.filter((visual) => visual.column === 2)}
            paragraphProps={paragraphProps}
            toggleVisual={NOOP}
            interactive={false}
          />
        </div>
      </div>
      <WorksheetContent worksheet={worksheet} paragraphs={middleFullParagraphs} visuals={EMPTY_ARRAY} paragraphProps={paragraphProps} toggleVisual={NOOP} interactive={false} />
      <WorksheetContent worksheet={worksheet} paragraphs={footerParagraphs} visuals={footerVisuals} paragraphProps={paragraphProps} toggleVisual={NOOP} interactive={false} />
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
        overlays.push({
          key: `${paragraph.paraIdx}-${blank.start}-${run.start}`,
          x: run.x + run.width * startRatio,
          top: run.top - run.height * 0.08,
          width: Math.max(run.width * (endRatio - startRatio), run.height * 0.8),
          height: run.height * 1.18,
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
  const [sourceVisualsByPage, setSourceVisualsByPage] = useState({})
  const [sourceLayoutsByPage, setSourceLayoutsByPage] = useState({})
  const [sourcePrintPagesByPage, setSourcePrintPagesByPage] = useState({})
  const [excludedVisualsByPage, setExcludedVisualsByPage] = useState({})
  const [alwaysBlankLinesByPage, setAlwaysBlankLinesByPage] = useState({})
  const [neverBlankLinesByPage, setNeverBlankLinesByPage] = useState({})
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
  const [worksheetTitle, setWorksheetTitle] = useState('빈칸 학습지')
  const [fileStatus, setFileStatus] = useState('')
  const fileInputRef = useRef(null)

  const levelObj = LEVELS.find((l) => l.id === level)
  const currentText = sourcePages[currentPage] || ''
  const alwaysBlankLines = alwaysBlankLinesByPage[currentPage] || EMPTY_SET
  const neverBlankLines = neverBlankLinesByPage[currentPage] || EMPTY_SET
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
    [currentText, levelObj, selectedCategories, alwaysBlankLines, neverBlankLines, alwaysList, neverList, manualInclude, manualExclude, currentVisuals, excludedVisuals, currentLayout, currentPrintPage],
  )

  const allPageWorksheets = useMemo(
    () =>
      sourcePages.map((text, i) =>
        buildWorksheet({
          sourceText: text,
          level: levelObj,
          selectedCategories,
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
    [sourcePages, levelObj, selectedCategories, alwaysBlankLinesByPage, neverBlankLinesByPage, alwaysList, neverList, manualIncludeByPage, manualExcludeByPage, sourceVisualsByPage, excludedVisualsByPage, sourceLayoutsByPage, sourcePrintPagesByPage],
  )

  const totalBlankCount = allPageWorksheets.reduce((s, w) => s + w.blankCount, 0)
  const hasOriginalPrintPages = allPageWorksheets.length > 0 && allPageWorksheets.every((worksheetPage) => worksheetPage.printPage)

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

  function cycleLineState(idx) {
    const isAlways = alwaysBlankLines.has(idx)
    const isNever = neverBlankLines.has(idx)
    setAlwaysBlankLinesByPage((prev) => {
      const next = new Set(prev[currentPage] || [])
      if (isAlways) next.delete(idx)
      else if (!isNever) next.add(idx)
      return { ...prev, [currentPage]: next }
    })
    setNeverBlankLinesByPage((prev) => {
      const next = new Set(prev[currentPage] || [])
      if (isAlways) next.add(idx)
      else if (isNever) next.delete(idx)
      return { ...prev, [currentPage]: next }
    })
  }

  function toggleVisual(visualId) {
    setExcludedVisualsByPage((prev) => {
      const next = new Set(prev[currentPage] || [])
      if (next.has(visualId)) next.delete(visualId)
      else next.add(visualId)
      return { ...prev, [currentPage]: next }
    })
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
    setExcludedVisualsByPage((prev) => ({ ...prev, [currentPage]: new Set() }))
    setUserAnswersByPage((prev) => ({ ...prev, [currentPage]: {} }))
    setCheckedByPage((prev) => ({ ...prev, [currentPage]: false }))
  }

  function handleDownload() {
    if (exportFormat === 'pdf') {
      window.print()
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
            <button className="print-btn" onClick={() => window.print()}>인쇄·PDF</button>
          </div>
          <div className="line-control-guide">
            줄 번호 클릭: <span className="guide-auto">자동</span> → <span className="guide-always">항상 빈칸</span> → <span className="guide-never">항상 남기기</span>
          </div>
          <div className="print-format-note">
            참고: 미리보기는 편집용 표시입니다. PDF 인쇄는 원문의 글자 크기·단 구성·그림·표 위치와 페이지 수를 그대로 유지하고, 선택한 빈칸만 원문 위치에 반영합니다.
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

          <div className="print-all-pages">
            {!hasOriginalPrintPages && (
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
              <div key={pageIdx} className={`print-page-block${ws.printPage ? ' original-layout' : ''}`}>
                {ws.printPage ? (
                  <OriginalPrintPage worksheet={ws} studyMode={studyMode} />
                ) : (
                  <PrintWorksheetContent
                    worksheet={ws}
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
                <span className="level-pct">{l.densityLabel || `약 ${Math.round(l.density * 100)}%`}</span>
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
            <span className="chip-row-label">추천</span>
            {CATEGORIES.filter((c) => c.group === 'recommend').map((c) => (
              <button key={c.id} className={`chip${selectedCategories.has(c.id) ? ' selected' : ''}`} onClick={() => toggleCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>

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
