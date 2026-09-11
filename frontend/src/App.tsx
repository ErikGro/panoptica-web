import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Stage, Layer, Image as KonvaImage, Line, Circle, Rect, RegularPolygon, Star, Transformer } from 'react-konva'
import type Konva from 'konva'

type MaskId = 'pred' | 'ref'
type ShapeKind = 'circle' | 'square' | 'triangle' | 'star'
type Tool = 'brush' | 'eraser' | 'select' | ShapeKind

interface BaseItem {
  id: string
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}
interface StrokeItem extends BaseItem {
  kind: 'stroke'
  points: number[]
  size: number
}
interface ShapeItem extends BaseItem {
  kind: ShapeKind
  radius: number
}
type Item = StrokeItem | ShapeItem

interface Snapshot {
  pred: Item[]
  ref: Item[]
}

type EvalResult = Record<string, number | string | null>

const PRED_COLOR = '#EDBC4F' // prediction — gold
const REF_COLOR = '#4D9CC8' // reference — blue
const SELECTION_COLOR = '#1e293b' // slate-800 — selection UI
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_STAGE_WIDTH = 900
const MAX_HISTORY = 50
const DEFAULT_SHAPE_RADIUS = 30 // size of a shape created by a click (no drag)
const MIN_SHAPE_RADIUS = 4

export default function App() {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [stageSize, setStageSize] = useState({ width: 700, height: 500 })

  const [activeMask, setActiveMask] = useState<MaskId>('pred')
  const [tool, setTool] = useState<Tool>('brush')
  const [brushSize, setBrushSize] = useState(24)

  const [predLines, setPredLines] = useState<Item[]>([])
  const [refLines, setRefLines] = useState<Item[]>([])

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [undoStack, setUndoStack] = useState<Snapshot[]>([])
  const [redoStack, setRedoStack] = useState<Snapshot[]>([])

  const [result, setResult] = useState<EvalResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stageRef = useRef<Konva.Stage>(null)
  const predLayerRef = useRef<Konva.Layer>(null)
  const refLayerRef = useRef<Konva.Layer>(null)
  const uiLayerRef = useRef<Konva.Layer>(null)
  const cursorRef = useRef<Konva.Circle>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  const isDrawing = useRef(false)
  const isErasing = useRef(false)
  const isShaping = useRef(false)
  const erasedThisGesture = useRef(false)
  const strokeSeq = useRef(0)
  const dragStart = useRef<Map<string, { x: number; y: number }> | null>(null)

  const setActiveLines = activeMask === 'pred' ? setPredLines : setRefLines
  const activeLines = activeMask === 'pred' ? predLines : refLines
  const activeColor = activeMask === 'pred' ? PRED_COLOR : REF_COLOR

  function nextId(): string {
    strokeSeq.current += 1
    return `s${strokeSeq.current}`
  }

  function newStroke(points: number[], size: number): StrokeItem {
    return { id: nextId(), kind: 'stroke', points, size, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
  }

  function newShape(kind: ShapeKind, x: number, y: number): ShapeItem {
    return { id: nextId(), kind, x, y, radius: DEFAULT_SHAPE_RADIUS, rotation: 0, scaleX: 1, scaleY: 1 }
  }

  function isShapeTool(t: Tool): t is ShapeKind {
    return t === 'circle' || t === 'square' || t === 'triangle' || t === 'star'
  }

  // Selection is scoped to the active mask, so changing mask/tool clears it.
  function changeMask(m: MaskId) {
    setActiveMask(m)
    setSelectedIds([])
  }

  function changeTool(t: Tool) {
    setTool(t)
    setSelectedIds([])
    // The brush/eraser hover cursor only applies to those tools.
    if (t !== 'brush' && t !== 'eraser') {
      cursorRef.current?.visible(false)
      uiLayerRef.current?.batchDraw()
    }
  }

  // ---- history -------------------------------------------------------------
  function pushHistory() {
    setUndoStack((prev) => {
      const next = [...prev, { pred: predLines, ref: refLines }]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
    setRedoStack([])
  }

  function undo() {
    if (undoStack.length === 0) return
    const snap = undoStack[undoStack.length - 1]
    setRedoStack((r) => [...r, { pred: predLines, ref: refLines }])
    setUndoStack((u) => u.slice(0, -1))
    setPredLines(snap.pred)
    setRefLines(snap.ref)
    setSelectedIds([])
  }

  function redo() {
    if (redoStack.length === 0) return
    const snap = redoStack[redoStack.length - 1]
    setUndoStack((u) => [...u, { pred: predLines, ref: refLines }])
    setRedoStack((r) => r.slice(0, -1))
    setPredLines(snap.pred)
    setRefLines(snap.ref)
    setSelectedIds([])
  }

  // ---- selection helpers ---------------------------------------------------
  function selectStroke(id: string, shift: boolean) {
    setSelectedIds((prev) => {
      if (shift) return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      return [id]
    })
  }

  function commitNodeAttrs() {
    const stage = stageRef.current
    if (!stage) return
    setActiveLines((prev) =>
      prev.map((s) => {
        if (!selectedIds.includes(s.id)) return s
        const node = stage.findOne('#' + s.id)
        if (!node) return s
        return {
          ...s,
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
        }
      }),
    )
  }

  function deleteSelection() {
    if (selectedIds.length === 0) return
    pushHistory()
    setActiveLines((prev) => prev.filter((s) => !selectedIds.includes(s.id)))
    setSelectedIds([])
  }

  // ---- drawing / pointer ---------------------------------------------------
  // Eraser: delete whole active-mask strokes under the pointer (hit-test via Konva).
  function eraseAtPointer() {
    const stage = stageRef.current
    const pos = stage?.getPointerPosition()
    if (!stage || !pos) return
    const id = stage.getIntersection(pos)?.id()
    if (!id || !activeLines.some((s) => s.id === id)) return
    if (!erasedThisGesture.current) {
      pushHistory()
      erasedThisGesture.current = true
    }
    setActiveLines((prev) => prev.filter((s) => s.id !== id))
  }

  function handlePointerDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    if (tool === 'select') {
      if (e.target === e.target.getStage()) setSelectedIds([])
      return
    }
    if (tool === 'eraser') {
      isErasing.current = true
      erasedThisGesture.current = false
      eraseAtPointer()
      return
    }
    const pos = stageRef.current?.getPointerPosition()
    if (!pos) return
    pushHistory()
    if (isShapeTool(tool)) {
      isShaping.current = true
      setActiveLines((prev) => [...prev, newShape(tool, pos.x, pos.y)])
      return
    }
    isDrawing.current = true
    // Duplicate the point so a click (no drag) paints a round dot.
    setActiveLines((prev) => [...prev, newStroke([pos.x, pos.y, pos.x, pos.y], brushSize)])
  }

  function handlePointerMove() {
    const pos = stageRef.current?.getPointerPosition()
    const cursor = cursorRef.current
    if (cursor && pos && (tool === 'brush' || tool === 'eraser')) {
      cursor.position({ x: pos.x, y: pos.y })
      cursor.visible(true)
      uiLayerRef.current?.batchDraw()
    }
    if (tool === 'eraser') {
      if (isErasing.current) eraseAtPointer()
      return
    }
    if (isShaping.current && pos) {
      // Drag out from the click point: radius = distance dragged.
      setActiveLines((prev) => {
        if (prev.length === 0) return prev
        const last = prev[prev.length - 1]
        if (last.kind === 'stroke') return prev
        const radius = Math.max(MIN_SHAPE_RADIUS, Math.hypot(pos.x - last.x, pos.y - last.y))
        return [...prev.slice(0, -1), { ...last, radius }]
      })
      return
    }
    if (!isDrawing.current || !pos) return
    setActiveLines((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      if (last.kind !== 'stroke') return prev
      const updated: StrokeItem = { ...last, points: [...last.points, pos.x, pos.y] }
      return [...prev.slice(0, -1), updated]
    })
  }

  function handlePointerUp() {
    isDrawing.current = false
    isErasing.current = false
    isShaping.current = false
  }

  function handlePointerLeave() {
    isDrawing.current = false
    isErasing.current = false
    isShaping.current = false
    cursorRef.current?.visible(false)
    uiLayerRef.current?.batchDraw()
  }

  // ---- move / transform (select mode) --------------------------------------
  function handleDragStart() {
    if (tool !== 'select') return
    // NB: no setState here — re-rendering mid-gesture breaks the drag/Transformer.
    const stage = stageRef.current
    const map = new Map<string, { x: number; y: number }>()
    if (stage) {
      for (const id of selectedIds) {
        const node = stage.findOne('#' + id)
        if (node) map.set(id, { x: node.x(), y: node.y() })
      }
    }
    dragStart.current = map
  }

  function handleDragMove(e: Konva.KonvaEventObject<DragEvent>, draggedId: string) {
    if (tool !== 'select' || selectedIds.length <= 1) return
    const stage = stageRef.current
    const start = dragStart.current
    if (!stage || !start) return
    const draggedStart = start.get(draggedId)
    if (!draggedStart) return
    const dx = e.target.x() - draggedStart.x
    const dy = e.target.y() - draggedStart.y
    for (const id of selectedIds) {
      if (id === draggedId) continue
      const other = stage.findOne('#' + id)
      const s = start.get(id)
      if (other && s) other.position({ x: s.x + dx, y: s.y + dy })
    }
  }

  function handleDragEnd() {
    if (tool !== 'select') return
    // predLines/refLines are still the pre-gesture state here, so snapshot now.
    pushHistory()
    commitNodeAttrs()
    dragStart.current = null
  }

  function handleTransformEnd() {
    pushHistory()
    commitNodeAttrs()
  }

  // ---- image / clear -------------------------------------------------------
  function handleImageUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      setError('Image exceeds the 10 MB limit.')
      return
    }
    setError(null)
    const url = URL.createObjectURL(file)
    const img = new window.Image()
    img.onload = () => {
      const scale = img.width > MAX_STAGE_WIDTH ? MAX_STAGE_WIDTH / img.width : 1
      setStageSize({ width: Math.round(img.width * scale), height: Math.round(img.height * scale) })
      setImage(img)
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  function clearActiveMask() {
    pushHistory()
    setActiveLines([])
    setSelectedIds([])
  }

  function clearAll() {
    setPredLines([])
    setRefLines([])
    setImage(null)
    setResult(null)
    setError(null)
    setSelectedIds([])
    setUndoStack([])
    setRedoStack([])
  }

  // ---- effects -------------------------------------------------------------
  // Hide the hover cursor until the pointer first enters the canvas.
  useEffect(() => {
    cursorRef.current?.visible(false)
    uiLayerRef.current?.batchDraw()
  }, [])

  // Keep the Transformer attached to the currently selected nodes.
  useEffect(() => {
    const tr = transformerRef.current
    const stage = stageRef.current
    if (!tr || !stage) return
    const nodes =
      tool === 'select'
        ? selectedIds
            .map((id) => stage.findOne('#' + id))
            .filter((n): n is Konva.Node => Boolean(n))
        : []
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [selectedIds, tool, predLines, refLines, activeMask])

  // Keyboard shortcuts — bound once, always reading the latest handlers.
  const latestRef = useRef({ undo, redo, deleteSelection, tool })
  useEffect(() => {
    latestRef.current = { undo, redo, deleteSelection, tool }
  })
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) latestRef.current.redo()
        else latestRef.current.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        latestRef.current.redo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && latestRef.current.tool === 'select') {
        e.preventDefault()
        latestRef.current.deleteSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- evaluate ------------------------------------------------------------
  async function handleEvaluate() {
    const predLayer = predLayerRef.current
    const refLayer = refLayerRef.current
    if (!predLayer || !refLayer) return
    if (predLines.length === 0 && refLines.length === 0) {
      setError('Draw at least one mask before evaluating.')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const predUrl = predLayer.toDataURL({ pixelRatio: 1 })
      const refUrl = refLayer.toDataURL({ pixelRatio: 1 })
      const [predBlob, refBlob] = await Promise.all([
        fetch(predUrl).then((r) => r.blob()),
        fetch(refUrl).then((r) => r.blob()),
      ])
      const form = new FormData()
      form.append('prediction', predBlob, 'prediction.png')
      form.append('reference', refBlob, 'reference.png')
      const res = await fetch('/api/evaluate', { method: 'POST', body: form })
      const text = await res.text()
      let data: EvalResult
      try {
        data = JSON.parse(text) as EvalResult
      } catch {
        throw new Error(
          'The API returned a non-JSON response. Make sure the panoptica server is running ' +
            '(`uv run panoptica-server`) and restart the Vite dev server so the /api proxy is active.',
        )
      }
      if (!res.ok) {
        throw new Error(String(data.error ?? `Request failed (${res.status})`))
      }
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // ---- render helpers ------------------------------------------------------
  function renderItem(s: Item, color: string) {
    const selectable = tool === 'select'
    const selected = selectable && selectedIds.includes(s.id)
    // Props shared by every item (transform, selection, drag).
    const common = {
      id: s.id,
      x: s.x,
      y: s.y,
      rotation: s.rotation,
      scaleX: s.scaleX,
      scaleY: s.scaleY,
      opacity: 0.5,
      draggable: selected,
      onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
        if (!selectable) return
        e.cancelBubble = true
        selectStroke(s.id, e.evt.shiftKey)
      },
      onTap: (e: Konva.KonvaEventObject<Event>) => {
        if (!selectable) return
        e.cancelBubble = true
        selectStroke(s.id, false)
      },
      onDragStart: handleDragStart,
      onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => handleDragMove(e, s.id),
      onDragEnd: handleDragEnd,
    }
    if (s.kind === 'stroke') {
      return (
        <Line
          key={s.id}
          {...common}
          points={s.points}
          stroke={color}
          strokeWidth={s.size}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(s.size, 12)}
        />
      )
    }
    // Filled primitive shapes.
    if (s.kind === 'circle') return <Circle key={s.id} {...common} radius={s.radius} fill={color} />
    if (s.kind === 'square')
      return (
        <Rect
          key={s.id}
          {...common}
          width={s.radius * 2}
          height={s.radius * 2}
          offsetX={s.radius}
          offsetY={s.radius}
          fill={color}
        />
      )
    if (s.kind === 'triangle')
      return <RegularPolygon key={s.id} {...common} sides={3} radius={s.radius} fill={color} />
    return <Star key={s.id} {...common} numPoints={5} innerRadius={s.radius * 0.5} outerRadius={s.radius} fill={color} />
  }

  const toolBtn = (t: Tool, label: string) => (
    <button
      onClick={() => changeTool(t)}
      className="rounded px-3 py-1.5 text-sm"
      style={tool === t ? { backgroundColor: '#1e293b', color: '#fff' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
    >
      {label}
    </button>
  )

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">panoptica mask evaluation — prototype</h1>
          <p className="text-sm text-slate-500">
            Optionally load an image, draw a{' '}
            <span className="font-medium" style={{ color: PRED_COLOR }}>
              prediction
            </span>{' '}
            and a{' '}
            <span className="font-medium" style={{ color: REF_COLOR }}>
              reference
            </span>{' '}
            mask, then evaluate.
          </p>
        </header>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex gap-1">
            <button
              onClick={() => changeMask('pred')}
              className="rounded px-3 py-1.5 text-sm font-medium"
              style={
                activeMask === 'pred'
                  ? { backgroundColor: PRED_COLOR, color: '#1e293b' }
                  : { backgroundColor: '#f1f5f9', color: '#475569' }
              }
            >
              Prediction
            </button>
            <button
              onClick={() => changeMask('ref')}
              className="rounded px-3 py-1.5 text-sm font-medium"
              style={
                activeMask === 'ref'
                  ? { backgroundColor: REF_COLOR, color: '#fff' }
                  : { backgroundColor: '#f1f5f9', color: '#475569' }
              }
            >
              Reference
            </button>
          </div>

          <div className="flex gap-1">
            {toolBtn('brush', 'Brush')}
            {toolBtn('eraser', 'Eraser')}
          </div>

          <div className="flex gap-1">
            {toolBtn('circle', '●')}
            {toolBtn('square', '■')}
            {toolBtn('triangle', '▲')}
            {toolBtn('star', '★')}
          </div>

          <div className="flex gap-1">{toolBtn('select', 'Select')}</div>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            Size
            <input
              type="range"
              min={2}
              max={80}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
            <span className="w-8 tabular-nums">{brushSize}</span>
          </label>

          <div className="flex gap-1">
            <button
              onClick={undo}
              disabled={undoStack.length === 0}
              className="rounded bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 disabled:opacity-40"
            >
              Undo
            </button>
            <button
              onClick={redo}
              disabled={redoStack.length === 0}
              className="rounded bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 disabled:opacity-40"
            >
              Redo
            </button>
          </div>

          <button
            onClick={clearActiveMask}
            className="rounded bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200"
          >
            Clear active mask
          </button>

          <label className="cursor-pointer rounded bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200">
            Load image
            <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
          </label>

          <button
            onClick={clearAll}
            className="rounded bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200"
          >
            Reset
          </button>

          <button
            onClick={handleEvaluate}
            disabled={loading}
            className="ml-auto rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? 'Evaluating…' : 'Evaluate'}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex flex-wrap gap-4">
          {/* Canvas */}
          <div
            className="inline-block rounded-lg border border-slate-300 bg-white shadow-sm"
            style={{ width: stageSize.width, height: stageSize.height }}
          >
            <Stage
              ref={stageRef}
              width={stageSize.width}
              height={stageSize.height}
              onMouseDown={handlePointerDown}
              onMouseMove={handlePointerMove}
              onMouseUp={handlePointerUp}
              onMouseLeave={handlePointerLeave}
              onTouchStart={handlePointerDown}
              onTouchMove={handlePointerMove}
              onTouchEnd={handlePointerUp}
              className={tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}
            >
              <Layer listening={false}>
                {image && <KonvaImage image={image} width={stageSize.width} height={stageSize.height} />}
              </Layer>
              <Layer
                ref={predLayerRef}
                listening={(tool === 'select' || tool === 'eraser') && activeMask === 'pred'}
              >
                {predLines.map((s) => renderItem(s, PRED_COLOR))}
              </Layer>
              <Layer
                ref={refLayerRef}
                listening={(tool === 'select' || tool === 'eraser') && activeMask === 'ref'}
              >
                {refLines.map((s) => renderItem(s, REF_COLOR))}
              </Layer>
              <Layer ref={uiLayerRef}>
                <Circle
                  ref={cursorRef}
                  radius={tool === 'eraser' ? 9 : brushSize / 2}
                  fill={tool === 'eraser' ? undefined : activeColor}
                  stroke={tool === 'eraser' ? '#ef4444' : undefined}
                  strokeWidth={tool === 'eraser' ? 2 : 0}
                  opacity={tool === 'eraser' ? 0.9 : 0.45}
                  listening={false}
                />
                <Transformer
                  ref={transformerRef}
                  rotateEnabled
                  resizeEnabled
                  ignoreStroke={false}
                  borderStroke={SELECTION_COLOR}
                  borderDash={[4, 4]}
                  anchorStroke={SELECTION_COLOR}
                  anchorFill="#ffffff"
                  anchorSize={8}
                  onTransformEnd={handleTransformEnd}
                />
              </Layer>
            </Stage>
          </div>

          {/* Results */}
          <div className="min-w-64 flex-1 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Result</h2>
            {result ? (
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(result).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-4 font-mono text-slate-500">{k}</td>
                      <td className="py-1 text-right tabular-nums text-slate-800">{formatValue(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-400">Draw both masks and click Evaluate.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatValue(v: number | string | null): string {
  if (v === null) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4)
  return v
}
