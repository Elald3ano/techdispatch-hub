import { useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDown,
  Home,
  Image,
  List,
  Loader2,
  MapPin,
  User,
  X,
} from 'lucide-react'
import type { Servicio, Tecnico } from '../../types'
import type { ToastVariant } from '../ToastContainer'
import { clasificarSla, esCritica, SLA_BADGE_CLASSES } from '../../lib/sla'
import {
  capturarElementoComoImagen,
  copiarImagenAlPortapapeles,
  descargarBlob,
} from '../../lib/imageExporter'
import { limpiarTexto } from '../../lib/normalizer'
import { cn } from '../../lib/utils'

const ITEMS_POR_PAGINA = 30

/** Opciones rápidas del selector de umbral; `null` = sin filtro de días. */
const UMBRALES_RAPIDOS: { valor: number | null; etiqueta: string }[] = [
  { valor: null, etiqueta: 'Todas las órdenes' },
  { valor: 2, etiqueta: '≥ 2 días (Con retraso)' },
  { valor: 3, etiqueta: '≥ 3 días (Críticas)' },
  { valor: 5, etiqueta: '≥ 5 días (Muy críticas)' },
  { valor: 7, etiqueta: '≥ 7 días (Severas)' },
]

type ColumnaOrden = 'dias' | 'orden' | 'ciudad' | 'barrio' | 'cliente' | 'servicio'
type ModoVista = 'barrios' | 'lista'

interface OrdenState {
  columna: ColumnaOrden
  direccion: 'asc' | 'desc'
}

interface RadiografiaTecnicoProps {
  tecnico: Tecnico
  servicios: Servicio[]
  barrioExpandido: string | null
  onToggleBarrio: (clave: string) => void
  onVerVistaGlobal: () => void
  notificar: (mensaje: string, variant?: ToastVariant) => void
}

interface ResumenBarrio {
  clave: string
  barrio: string
  ciudad: string
  total: number
  criticos: number
  ordenes: Servicio[]
}

/** Radiografía táctica de un técnico: desglose, filtro por servicio y vistas. */
export function RadiografiaTecnico({
  tecnico,
  servicios,
  barrioExpandido,
  onToggleBarrio,
  onVerVistaGlobal,
  notificar,
}: RadiografiaTecnicoProps) {
  const [serviciosFiltro, setServiciosFiltro] = useState<string[]>([])
  const [modoVista, setModoVista] = useState<ModoVista>('barrios')
  const [orden, setOrden] = useState<OrdenState>({ columna: 'dias', direccion: 'desc' })
  const [pagina, setPagina] = useState(1)
  const [generandoPdf, setGenerandoPdf] = useState(false)
  // `null` = todas las edades; número = filtrar órdenes con `dias_antiguedad >= umbralDias`.
  const [umbralDias, setUmbralDias] = useState<number | null>(null)
  const [umbralBorrador, setUmbralBorrador] = useState('')
  const [capturando, setCapturando] = useState(false)
  // Marca de tiempo estable por montaje: evita `new Date()` durante el render.
  const [marcaCaptura] = useState(() =>
    new Date().toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
  )
  const capturaRef = useRef<HTMLDivElement>(null)

  const total = servicios.length

  // Modo "Sin Asignar": el Centro de Mando envía un técnico sintético para las
  // órdenes huérfanas; lo detectamos por su id o su nombre.
  const esModoSinAsignar = tecnico.id === 'sin_asignar' || tecnico.nombre === 'Sin Asignar'

  // Desglose por tipo de servicio (siempre sobre el total del técnico, Invariante #1).
  const desgloseServicios = useMemo(() => {
    const porTipo = new Map<string, { clave: string; label: string; cantidad: number }>()
    for (const s of servicios) {
      const clave = limpiarTexto(s.tipo_servicio)
      const prev = porTipo.get(clave)
      if (prev) prev.cantidad += 1
      else porTipo.set(clave, { clave, label: s.tipo_servicio, cantidad: 1 })
    }
    return [...porTipo.values()].sort((a, b) => b.cantidad - a.cantidad)
  }, [servicios])

  // Órdenes que cumplen los filtros activos: umbral dinámico de días + chips de servicio.
  const serviciosFiltrados = useMemo(() => {
    const set = new Set(serviciosFiltro)
    return servicios.filter((s) => {
      if (umbralDias !== null && s.dias_antiguedad < umbralDias) return false
      if (set.size > 0 && !set.has(limpiarTexto(s.tipo_servicio))) return false
      return true
    })
  }, [servicios, serviciosFiltro, umbralDias])

  // Barrios del técnico (acordeón) sobre las órdenes filtradas, por criticidad.
  const barrios = useMemo(() => {
    const porBarrio = new Map<string, ResumenBarrio>()
    for (const s of serviciosFiltrados) {
      const barrio = s.barrio || 'Sin barrio'
      const ciudad = s.ciudad || 'Sin ciudad'
      const clave = `${limpiarTexto(ciudad)}|${limpiarTexto(barrio)}`
      const prev = porBarrio.get(clave)
      if (prev) {
        prev.total += 1
        if (esCritica(s.dias_antiguedad)) prev.criticos += 1
        prev.ordenes.push(s)
      } else {
        porBarrio.set(clave, {
          clave,
          barrio,
          ciudad,
          total: 1,
          criticos: esCritica(s.dias_antiguedad) ? 1 : 0,
          ordenes: [s],
        })
      }
    }
    return [...porBarrio.values()].sort(
      (a, b) => b.total - a.total || b.criticos - a.criticos,
    )
  }, [serviciosFiltrados])

  // Lista plana ordenada (por defecto: días de mayor a menor).
  const ordenados = useMemo(() => {
    const factor = orden.direccion === 'asc' ? 1 : -1
    return [...serviciosFiltrados].sort((a, b) => {
      let cmp = 0
      switch (orden.columna) {
        case 'dias':
          cmp = a.dias_antiguedad - b.dias_antiguedad
          break
        case 'orden':
          cmp = a.numero_orden.localeCompare(b.numero_orden, undefined, { numeric: true })
          break
        case 'ciudad':
          cmp = a.ciudad.localeCompare(b.ciudad)
          break
        case 'barrio':
          cmp = a.barrio.localeCompare(b.barrio)
          break
        case 'cliente':
          cmp = (a.nombre_cliente ?? '').localeCompare(b.nombre_cliente ?? '')
          break
        case 'servicio':
          cmp = a.tipo_servicio.localeCompare(b.tipo_servicio)
          break
      }
      return cmp * factor
    })
  }, [serviciosFiltrados, orden])

  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / ITEMS_POR_PAGINA))
  const paginaActual = Math.min(pagina, totalPaginas)
  const visibles = useMemo(() => {
    const inicio = (paginaActual - 1) * ITEMS_POR_PAGINA
    return ordenados.slice(inicio, inicio + ITEMS_POR_PAGINA)
  }, [ordenados, paginaActual])

  function toggleChip(clave: string) {
    setServiciosFiltro((prev) =>
      prev.includes(clave) ? prev.filter((c) => c !== clave) : [...prev, clave],
    )
  }

  function limpiarChips() {
    setServiciosFiltro([])
  }

  function ordenarPor(columna: ColumnaOrden) {
    setOrden((prev) =>
      prev.columna === columna
        ? { columna, direccion: prev.direccion === 'asc' ? 'desc' : 'asc' }
        : { columna, direccion: columna === 'dias' ? 'desc' : 'asc' },
    )
  }

  // Exportación en 1 clic: respeta chips + umbral de días + orden de columnas.
  async function descargarPlanilla() {
    const ordenesOrdenadas = serviciosFiltrados
    if (ordenesOrdenadas.length === 0) {
      notificar('Este técnico no tiene órdenes para exportar.', 'error')
      return
    }
    setGenerandoPdf(true)
    try {
      const { exportarVistaActualPdf, slugificar, marcaDeTiempo } = await import(
        '../../services/pdfGenerator'
      )
      const ciudadesUnicas = [...new Set(ordenesOrdenadas.map((s) => s.ciudad))].sort()
      // Nota táctica: filtros activos + ordenamiento de la tabla.
      const filtros: string[] = []
      if (umbralDias !== null) filtros.push(`≥ ${umbralDias} días`)
      if (serviciosFiltro.length > 0) filtros.push(`${serviciosFiltro.length} servicio(s)`)
      const notaFiltros = `Filtros: ${
        filtros.length > 0 ? filtros.join(' + ') : 'Todas'
      } | Ordenado por: ${orden.columna} (${orden.direccion})`

      const doc = await exportarVistaActualPdf(ordenesOrdenadas, [tecnico], {
        conteo: ordenesOrdenadas.length,
        ciudad: ciudadesUnicas.join(', ') || 'Todas',
        barrio: 'Todas',
        tecnico: tecnico.nombre,
        columna: orden.columna,
        direccion: orden.direccion,
        notaFiltros,
      })
      const sufijo = umbralDias !== null ? `-mas-${umbralDias}dias` : ''
      doc.save(`PD-${slugificar(tecnico.nombre)}${sufijo}-${marcaDeTiempo()}.pdf`)
      notificar(`Planilla de ${tecnico.nombre} descargada con éxito.`, 'success')
    } catch (error) {
      notificar(
        error instanceof Error ? error.message : 'No se pudo generar el PDF.',
        'error',
      )
    } finally {
      setGenerandoPdf(false)
    }
  }

  // Nombre del PNG compartido entre la copia y la descarga directa.
  async function nombrePng(): Promise<string> {
    const { slugificar, marcaDeTiempo } = await import('../../services/pdfGenerator')
    const sufijo = umbralDias !== null ? `-mas-${umbralDias}dias` : ''
    return `PD-${slugificar(tecnico.nombre)}${sufijo}-${marcaDeTiempo()}.png`
  }

  /** Captura la tarjeta en HD y la copia al portapapeles (fallback: descarga). */
  async function copiarParaWhatsApp() {
    if (!capturaRef.current || capturando) return
    setCapturando(true)
    try {
      const { blob } = await capturarElementoComoImagen(capturaRef.current)
      const copiada = await copiarImagenAlPortapapeles(blob)
      if (copiada) {
        notificar(
          '📋 Imagen copiada. Ve a WhatsApp y presiona Ctrl + V para enviarla.',
          'success',
        )
      } else {
        descargarBlob(blob, await nombrePng())
        notificar(
          'Este navegador no permite copiar imágenes; se descargó el PNG.',
          'info',
        )
      }
    } catch (error) {
      notificar(
        error instanceof Error ? error.message : 'No se pudo capturar la imagen.',
        'error',
      )
    } finally {
      setCapturando(false)
    }
  }

  /** Descarga la carta del técnico como PNG HD. */
  async function descargarPng() {
    if (!capturaRef.current || capturando) return
    setCapturando(true)
    try {
      const { blob } = await capturarElementoComoImagen(capturaRef.current)
      descargarBlob(blob, await nombrePng())
      notificar(`Imagen de ${tecnico.nombre} descargada.`, 'success')
    } catch (error) {
      notificar(
        error instanceof Error ? error.message : 'No se pudo generar el PNG.',
        'error',
      )
    } finally {
      setCapturando(false)
    }
  }

  return (
    <section className="relative overflow-hidden rounded-2xl bg-slate-900 p-5 text-slate-100 shadow-lg ring-1 ring-cyan-400/25">
      {/* Cabecera (controles: fuera del área capturable) */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 ring-1 ring-cyan-400/30">
            <User className="size-5 text-cyan-300" />
          </span>
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-base font-bold text-white">
              <span className="truncate">
                {esModoSinAsignar ? '⚠️ Órdenes Sin Asignar' : tecnico.nombre}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-semibold ring-1 tabular-nums',
                  esModoSinAsignar || umbralDias !== null
                    ? 'bg-amber-500/15 text-amber-200 ring-amber-500/30'
                    : 'bg-white/10 text-slate-200 ring-white/15',
                )}
              >
                {umbralDias !== null
                  ? `${serviciosFiltrados.length} órdenes (≥ ${umbralDias} días) de ${total} totales`
                  : `${total} órdenes`}
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              {esModoSinAsignar
                ? 'Órdenes huérfanas que requieren asignación territorial'
                : 'Radiografía por zona del técnico'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* Umbral dinámico de días */}
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 transition',
              umbralDias !== null
                ? 'border-amber-500 bg-amber-950/60 text-amber-200'
                : 'border-white/10 bg-white/5 text-slate-300',
            )}
          >
            <label htmlFor="umbral-dias-tecnico" className="sr-only">
              Filtrar por días mínimos de antigüedad
            </label>
            <select
              id="umbral-dias-tecnico"
              value={umbralDias === null ? 'todas' : String(umbralDias)}
              onChange={(e) => {
                const valor = e.target.value
                setUmbralDias(valor === 'todas' ? null : Number(valor))
                setUmbralBorrador('')
              }}
              className="cursor-pointer rounded border-none bg-transparent text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <option value="todas" className="bg-slate-900 text-slate-200">
                ⏱️ Todas las edades
              </option>
              {UMBRALES_RAPIDOS.map((o) => (
                <option key={o.etiqueta} value={o.valor ?? 'todas'} className="bg-slate-900 text-slate-200">
                  {o.etiqueta}
                </option>
              ))}
            </select>

            <input
              type="number"
              min={1}
              max={365}
              inputMode="numeric"
              value={umbralBorrador}
              onChange={(e) => setUmbralBorrador(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const n = Number(umbralBorrador)
                if (!Number.isFinite(n) || n < 1) return
                setUmbralDias(Math.floor(n))
                setUmbralBorrador('')
              }}
              placeholder="≥ n"
              aria-label="Umbral personalizado de días (Enter para aplicar)"
              className="w-14 rounded border border-slate-700 bg-slate-950 py-0.5 text-center text-[11px] font-semibold text-amber-200 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />

            {umbralDias !== null && (
              <button
                type="button"
                onClick={() => {
                  setUmbralDias(null)
                  setUmbralBorrador('')
                }}
                aria-label="Quitar filtro de días"
                className="inline-flex items-center rounded p-0.5 text-amber-200/80 transition hover:bg-amber-500/20 hover:text-amber-100"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void descargarPlanilla()}
            disabled={generandoPdf || serviciosFiltrados.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generandoPdf ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileDown className="size-3.5" />
            )}
            {generandoPdf ? 'Generando…' : 'Descargar Planilla PDF'}
          </button>
          <button
            type="button"
            onClick={() => void copiarParaWhatsApp()}
            disabled={capturando || serviciosFiltrados.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-500/30 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {capturando ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {capturando ? 'Capturando…' : 'Copiar para WhatsApp'}
          </button>
          <button
            type="button"
            onClick={() => void descargarPng()}
            disabled={capturando || serviciosFiltrados.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Image className="size-3.5" /> PNG
          </button>
          <button
            type="button"
            onClick={onVerVistaGlobal}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
          >
            <X className="size-3.5" /> Ver Vista Global
          </button>
        </div>
      </header>

      {/* Área capturable como imagen: resumen + órdenes visibles */}
      <div
        ref={capturaRef}
        className="-mx-2 rounded-xl bg-slate-900 px-2 pt-2"
      >
        {/* Cabecera de la carta: técnico, ciudades y fecha/hora */}
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wide text-cyan-300 uppercase">
              MillaOps Hub · Radiografía de despacho
            </p>
            <p className="truncate text-base font-bold text-white">
              {esModoSinAsignar ? 'Órdenes Sin Asignar' : tecnico.nombre}
            </p>
            <p className="text-[11px] text-slate-400">
              {[...new Set(serviciosFiltrados.map((s) => s.ciudad))].sort().join(', ') ||
                'Sin ciudad'}
            </p>
          </div>
          <p className="text-[11px] text-slate-400 tabular-nums">{marcaCaptura}</p>
        </div>

        {/* Cajas de resumen */}
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/10">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
              Total órdenes
            </p>
            <p className="text-lg font-bold text-white tabular-nums">
              {serviciosFiltrados.length}
            </p>
          </div>
          <div className="rounded-lg bg-red-500/10 px-3 py-2 ring-1 ring-red-500/30">
            <p className="text-[10px] font-semibold tracking-wide text-red-300 uppercase">
              Críticas (3+ días)
            </p>
            <p className="text-lg font-bold text-red-300 tabular-nums">
              {serviciosFiltrados.filter((s) => esCritica(s.dias_antiguedad)).length}
            </p>
          </div>
        </div>

      {/* Desglose de tipos de servicio (chips interactivos) */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-300">Desglose por tipo de servicio</p>
          {serviciosFiltro.length > 0 && (
            <button
              type="button"
              onClick={limpiarChips}
              className="text-[11px] font-medium text-cyan-300 underline-offset-2 transition hover:underline"
            >
              Limpiar
            </button>
          )}
        </div>
        {desgloseServicios.length === 0 ? (
          <p className="text-xs text-slate-500">Sin órdenes en el ámbito seleccionado.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {desgloseServicios.map((d) => {
              const activo = serviciosFiltro.includes(d.clave)
              return (
                <button
                  key={d.clave}
                  type="button"
                  onClick={() => toggleChip(d.clave)}
                  aria-pressed={activo}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition-all select-none',
                    activo
                      ? 'border border-cyan-400 bg-cyan-950/70 text-cyan-200 ring-1 ring-cyan-400'
                      : 'bg-white/5 text-slate-200 ring-1 ring-white/10 hover:bg-white/10',
                  )}
                >
                  {d.label}
                  <span
                    className={cn(
                      'font-bold tabular-nums',
                      activo ? 'text-cyan-300' : 'text-slate-400',
                    )}
                  >
                    {d.cantidad}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Conmutador de vistas */}
      <div className="mb-4 flex gap-1 rounded-lg bg-white/5 p-1 ring-1 ring-white/10">
        <button
          type="button"
          onClick={() => setModoVista('barrios')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
            modoVista === 'barrios' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          <Home className="size-3.5" /> Por Barrios
        </button>
        <button
          type="button"
          onClick={() => setModoVista('lista')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
            modoVista === 'lista' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          <List className="size-3.5" /> Todas las Órdenes
        </button>
      </div>

      {modoVista === 'barrios' ? (
        /* ---- Vista por barrios (acordeón) ---- */
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-300">
            Zonas asignadas ({barrios.length})
          </p>
          {barrios.length === 0 ? (
            <p className="text-xs text-slate-500">
              Este técnico no tiene órdenes que cumplan los filtros.
            </p>
          ) : (
            <div className="space-y-1.5">
              {barrios.map((b) => {
                const expandido = barrioExpandido === b.clave
                return (
                  <div
                    key={b.clave}
                    className="overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleBarrio(b.clave)}
                      aria-expanded={expandido}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-white/5"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 text-slate-400 transition-transform',
                            expandido && 'rotate-180',
                          )}
                        />
                        <span className="truncate text-sm font-medium text-slate-100">
                          {b.barrio}
                        </span>
                        <span className="shrink-0 text-[11px] text-slate-500">{b.ciudad}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs font-semibold text-slate-300 tabular-nums">
                          {b.total}
                        </span>
                        {b.criticos > 0 && (
                          <span className="rounded-md bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-300 tabular-nums ring-1 ring-red-500/30">
                            {b.criticos} críticas
                          </span>
                        )}
                      </span>
                    </button>

                    {expandido && (
                      <div className="border-t border-white/10">
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[560px] text-left text-xs">
                            <thead>
                              <tr className="border-b border-white/10 text-[10px] tracking-wide text-slate-400 uppercase">
                                <th className="px-3 py-1.5 font-semibold">Días</th>
                                <th className="px-3 py-1.5 font-semibold">Orden #</th>
                                <th className="px-3 py-1.5 font-semibold">Dirección</th>
                                <th className="px-3 py-1.5 font-semibold">Cliente / Ref</th>
                                <th className="px-3 py-1.5 font-semibold">Servicio</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {b.ordenes.map((s) => (
                                <tr key={s.id} className="align-top">
                                  <td className="px-3 py-1.5 whitespace-nowrap">
                                    <BadgeDias dias={s.dias_antiguedad} />
                                  </td>
                                  <td className="px-3 py-1.5 font-mono text-[11px] font-bold whitespace-nowrap text-white">
                                    {s.numero_orden}
                                  </td>
                                  <td className="px-3 py-1.5 text-slate-300">
                                    {s.direccion || '—'}
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <p className="font-semibold text-slate-100">
                                      {s.nombre_cliente || 'SIN NOMBRE'}
                                    </p>
                                    <p className="text-[10px] text-slate-500">
                                      Ref: {s.referencia_pago || 'S/R'}
                                    </p>
                                  </td>
                                  <td className="px-3 py-1.5 text-slate-300">{s.tipo_servicio}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        /* ---- Vista de lista plana (todas las órdenes) ---- */
        <div>
          <div className="overflow-hidden rounded-lg ring-1 ring-white/10">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-white/5 text-[10px] tracking-wide text-slate-400 uppercase">
                  <tr>
                    <ThOrdenable label="Días" columna="dias" orden={orden} onOrdenar={ordenarPor} />
                    <ThOrdenable label="Orden #" columna="orden" orden={orden} onOrdenar={ordenarPor} />
                    <ThOrdenable label="Ciudad" columna="ciudad" orden={orden} onOrdenar={ordenarPor} />
                    <ThOrdenable
                      label="Barrio / Dirección"
                      columna="barrio"
                      orden={orden}
                      onOrdenar={ordenarPor}
                    />
                    <ThOrdenable
                      label="Cliente / Ref. Pago"
                      columna="cliente"
                      orden={orden}
                      onOrdenar={ordenarPor}
                    />
                    <ThOrdenable
                      label="Servicio"
                      columna="servicio"
                      orden={orden}
                      onOrdenar={ordenarPor}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {visibles.map((s) => (
                    <tr key={s.id} className="align-top">
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <BadgeDias dias={s.dias_antiguedad} />
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] font-bold whitespace-nowrap text-white">
                        {s.numero_orden}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-slate-200">
                          <MapPin className="size-3 shrink-0 text-cyan-400" />
                          <span className="font-semibold">{s.ciudad}</span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <p className="font-semibold text-slate-100">{s.barrio || '—'}</p>
                        <p className="text-[11px] text-slate-400">{s.direccion || '—'}</p>
                      </td>
                      <td className="px-3 py-1.5">
                        <p className="font-semibold text-slate-100">
                          {s.nombre_cliente || 'SIN NOMBRE'}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          Ref: {s.referencia_pago || 'S/R'}
                        </p>
                      </td>
                      <td className="px-3 py-1.5 text-slate-300">{s.tipo_servicio}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibles.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-slate-500">
                Sin órdenes con los filtros actuales.
              </p>
            )}
          </div>

          {/* Paginación */}
          {ordenados.length > 0 && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-500 tabular-nums">
                Mostrando {(paginaActual - 1) * ITEMS_POR_PAGINA + 1}–
                {Math.min(paginaActual * ITEMS_POR_PAGINA, ordenados.length)} de{' '}
                {ordenados.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPagina((p) => Math.max(1, p - 1))}
                  disabled={paginaActual <= 1}
                  className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="size-3.5" /> Anterior
                </button>
                <span className="px-2 text-[11px] text-slate-400 tabular-nums">
                  {paginaActual} / {totalPaginas}
                </span>
                <button
                  type="button"
                  onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                  disabled={paginaActual >= totalPaginas}
                  className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Siguiente <ChevronRight className="size-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </section>
  )
}

/** Encabezado clicable para ordenamiento interactivo. */
function ThOrdenable({
  label,
  columna,
  orden,
  onOrdenar,
}: {
  label: string
  columna: ColumnaOrden
  orden: OrdenState
  onOrdenar: (columna: ColumnaOrden) => void
}) {
  const activa = orden.columna === columna
  return (
    <th
      scope="col"
      onClick={() => onOrdenar(columna)}
      aria-sort={activa ? (orden.direccion === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="cursor-pointer px-3 py-1.5 font-semibold whitespace-nowrap select-none transition hover:bg-white/5"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {activa &&
          (orden.direccion === 'asc' ? (
            <ArrowUp className="size-3 text-cyan-300" />
          ) : (
            <ArrowDown className="size-3 text-cyan-300" />
          ))}
      </span>
    </th>
  )
}

/** Bloque sólido de SLA (semáforo) para la columna "Días". */
function BadgeDias({ dias }: { dias: number }) {
  const nivel = clasificarSla(dias)
  return (
    <span
      className={cn(
        'inline-block rounded-md px-2 py-0.5 text-center text-[11px] font-bold tabular-nums',
        SLA_BADGE_CLASSES[nivel],
      )}
    >
      {dias} {dias === 1 ? 'día' : 'días'}
    </span>
  )
}
