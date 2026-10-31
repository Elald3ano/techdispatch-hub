import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, CodeXml, Database, FileText, Layers, Map as MapIcon, RefreshCw, ShieldCheck, ShieldAlert, SlidersHorizontal, TrendingUp, WifiOff } from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { DirectorioTecnicos } from './components/territorio/DirectorioTecnicos'
import { DetalleTecnicoTerritorio } from './components/territorio/DetalleTecnicoTerritorio'
import { AnaliticaDashboard } from './components/analitica/AnaliticaDashboard'
import { AuditoriaCierresDashboard } from './components/cierres/AuditoriaCierresDashboard'
import { ToastContainer, type Toast, type ToastVariant } from './components/ToastContainer'
import { RulesManagerModal } from './components/RulesManagerModal'
import { PdfExportModal } from './components/PdfExportModal'
import { aplicarMatrizAsignacion } from './services/assignmentEngine'
import { isSupabaseConfigured } from './lib/supabase'
import {
  getCiudadesActivas,
  getReglas,
  getServiciosActivos,
  getTecnicos,
  getUltimaAuditoriaCierres,
  reasignarServiciosActivos,
  reemplazarServiciosActivos,
} from './services/supabaseService'
import type { ReglaConTecnico, Servicio, Tecnico } from './types'
import type { ResultadoCierres } from './services/reconciliationService'
import { cn } from './lib/utils'

type EstadoConexion = 'conectando' | 'conectado' | 'error'
type VistaPrincipal = 'centro_mando' | 'territorio' | 'cierres'

const MAX_TOASTS = 4

function App() {
  // Datos
  const [tecnicos, setTecnicos] = useState<Tecnico[]>([])
  const [reglas, setReglas] = useState<ReglaConTecnico[]>([])
  const [serviciosActivos, setServiciosActivos] = useState<Servicio[]>([])

  // UI
  const [cargando, setCargando] = useState(true)
  const [procesando, setProcesando] = useState(false)
  const [sincronizando, setSincronizando] = useState(false)
  const [conexion, setConexion] = useState<EstadoConexion>('conectando')
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const [matrizAbierta, setMatrizAbierta] = useState(false)
  const [pdfAbierto, setPdfAbierto] = useState(false)

  // Navegación principal + Gestión Territorial
  const [vistaActiva, setVistaActiva] = useState<VistaPrincipal>('centro_mando')
  const [tecnicoSeleccionadoId, setTecnicoSeleccionadoId] = useState<string | null>(null)

  // Auditoría de Cierres: estado levantado para persistir entre pestañas.
  const [resultadoCierres, setResultadoCierres] = useState<ResultadoCierres | null>(null)
  const [corteAyerNombre, setCorteAyerNombre] = useState('')
  const [corteHoyNombre, setCorteHoyNombre] = useState('')
  const [fechaCorteAnterior, setFechaCorteAnterior] = useState<Date | null>(null)
  const [fechaCorteActual, setFechaCorteActual] = useState<Date | null>(null)
  const [ciudadesActivas, setCiudadesActivas] = useState<Record<string, string[]>>({})

  const notificar = useCallback((mensaje: string, variant: ToastVariant = 'info') => {
    const id = ++toastId.current
    setToasts((prev) => [...prev, { id, variant, mensaje }].slice(-MAX_TOASTS))
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4500)
  }, [])

  const descartarToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const refrescarReglas = useCallback(async () => {
    const [reglasData, tecnicosData] = await Promise.all([getReglas(), getTecnicos()])
    setReglas(reglasData)
    setTecnicos(tecnicosData)
  }, [])

  const cargarDatos = useCallback(
    async (silencioso = false) => {
      if (!silencioso) setCargando(true)
      // Sin credenciales válidas no se intenta consultar: la UI muestra un banner.
      if (!isSupabaseConfigured) {
        setConexion('error')
        setCargando(false)
        return
      }
      try {
        const [tecnicosData, reglasData, serviciosData, ciudadesData] = await Promise.all([
          getTecnicos(),
          getReglas(),
          getServiciosActivos(),
          getCiudadesActivas(),
        ])

        setTecnicos(tecnicosData)
        setReglas(reglasData)
        setServiciosActivos(serviciosData)
        setCiudadesActivas(ciudadesData)
        setConexion('conectado')
      } catch (error) {
        // Nunca se propaga: la app sigue montada y muestra el estado de error.
        setConexion('error')
        notificar(
          error instanceof Error ? error.message : 'No se pudieron cargar los datos iniciales.',
          'error',
        )
      } finally {
        setCargando(false)
      }
    },
    [notificar],
  )

  useEffect(() => {
    // Carga inicial desde Supabase: sincroniza con el sistema externo.
    // oxlint-disable-next-line react/set-state-in-effect
    void cargarDatos()
  }, [cargarDatos])

  // Hidrata la última auditoría guardada en la nube (persistencia tras F5 y
  // para compañeros). Silencioso si la tabla aún no existe (migración pendiente).
  const cargarUltimaAuditoria = useCallback(async () => {
    try {
      const ultima = await getUltimaAuditoriaCierres()
      if (!ultima) return
      setResultadoCierres(ultima.datos_resultado)
      setCorteAyerNombre(ultima.nombre_archivo_anterior)
      setCorteHoyNombre(ultima.nombre_archivo_actual)
      setFechaCorteAnterior(
        ultima.fecha_corte_anterior ? new Date(ultima.fecha_corte_anterior) : null,
      )
      setFechaCorteActual(
        ultima.fecha_corte_actual ? new Date(ultima.fecha_corte_actual) : null,
      )
    } catch {
      // Silencioso: la tabla puede no existir aún (migración pendiente).
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void cargarUltimaAuditoria()
  }, [cargarUltimaAuditoria])

  const tecnicoSeleccionado = useMemo(
    () => tecnicos.find((t) => t.id === tecnicoSeleccionadoId) ?? null,
    [tecnicos, tecnicoSeleccionadoId],
  )

  const refrescarTerritorio = useCallback(async () => {
    const [reglasData, tecnicosData, ciudadesData] = await Promise.all([
      getReglas(),
      getTecnicos(),
      getCiudadesActivas(),
    ])
    setReglas(reglasData)
    setTecnicos(tecnicosData)
    setCiudadesActivas(ciudadesData)
  }, [])

  const refrescarServicios = useCallback(async () => {
    const serviciosData = await getServiciosActivos()
    setServiciosActivos(serviciosData)
  }, [])

  // Refresca territorio + servicios tras guardar una cuadrilla.
  const refrescarTrasGuardarCuadrilla = useCallback(async () => {
    await Promise.all([refrescarTerritorio(), refrescarServicios()])
  }, [refrescarTerritorio, refrescarServicios])

  // Refresca el directorio y selecciona al técnico recién creado.
  const handleTecnicoCreado = useCallback(
    async (nuevo: Tecnico) => {
      await refrescarTerritorio()
      setTecnicoSeleccionadoId(nuevo.id)
    },
    [refrescarTerritorio],
  )

  const volverAlDirectorio = useCallback(async () => {
    setTecnicoSeleccionadoId(null)
    await refrescarTerritorio()
  }, [refrescarTerritorio])

  const reaplicarMatriz = useCallback(() => {
    const reasignados = aplicarMatrizAsignacion(serviciosActivos, reglas)
    const tecnicoPorOrden = new Map<string, string | null>()
    for (const servicio of reasignados) {
      tecnicoPorOrden.set(servicio.numero_orden, servicio.tecnico_id)
    }
    setServiciosActivos((prev) =>
      prev.map((servicio) => {
        const nuevoTecnico = tecnicoPorOrden.get(servicio.numero_orden)
        return nuevoTecnico !== undefined ? { ...servicio, tecnico_id: nuevoTecnico } : servicio
      }),
    )
    notificar('Matriz re-aplicada a los servicios en pantalla.', 'success')
  }, [serviciosActivos, reglas, notificar])

  const handleSincronizar = useCallback(async () => {
    setSincronizando(true)
    try {
      const { asignadas, desasignadas } = await reasignarServiciosActivos()
      await refrescarServicios()
      notificar(
        `Matriz sincronizada: ${asignadas} asignadas, ${desasignadas} liberadas.`,
        'success',
      )
    } catch (error) {
      notificar(
        error instanceof Error ? error.message : 'No se pudo sincronizar las asignaciones.',
        'error',
      )
    } finally {
      setSincronizando(false)
    }
  }, [refrescarServicios, notificar])

  const handleProcesar = useCallback(
    async (file: File, ciudadFiltro: string | undefined): Promise<boolean> => {
      setProcesando(true)
      const nombre = `${file.name.replace(/\.(xlsx|xls)$/i, '')} — ${format(new Date(), 'dd MMM yyyy HH:mm', { locale: es })}`

      try {
        // 1. Parseo del Excel (carga diferida: xlsx es un chunk pesado)
        const { parseServiciosExcel } = await import('./services/excelParser')
        const nuevos = await parseServiciosExcel(file, ciudadFiltro)
        if (nuevos.length === 0) {
          notificar(
            ciudadFiltro
              ? `No se encontraron servicios para la ciudad "${ciudadFiltro}".`
              : 'El archivo no contiene servicios válidos.',
            'error',
          )
          return false
        }

        // 2. Reglas territoriales activas (si el estado local está vacío, se consulta).
        let reglasActivas = reglas
        if (reglasActivas.length === 0) {
          reglasActivas = await getReglas()
        }
        console.log(`[Asignacion] Reglas activas disponibles: ${reglasActivas.length}`)

        // 3. Asignación directa con la matriz.
        const asignados = aplicarMatrizAsignacion(nuevos, reglasActivas)

        // 4. Reemplazar el despacho activo en Supabase.
        await reemplazarServiciosActivos(nombre, asignados)

        // 5. Refrescar el estado con los servicios persistidos (ids reales).
        await cargarDatos(true)

        const asignadosCount = asignados.filter((s) => s.tecnico_id !== null).length
        notificar(
          `Despacho listo: ${asignados.length} órdenes (${asignadosCount} asignadas).`,
          'success',
        )
        return true
      } catch (error) {
        notificar(
          error instanceof Error ? error.message : 'No se pudo procesar el archivo.',
          'error',
        )
        return false
      } finally {
        setProcesando(false)
      }
    },
    [reglas, cargarDatos, notificar],
  )

  const conexionInfo =
    conexion === 'conectado'
      ? { label: 'Supabase conectado', icon: ShieldCheck, classes: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' }
      : conexion === 'error'
        ? { label: 'Sin conexión', icon: WifiOff, classes: 'bg-red-500/15 text-red-300 ring-red-500/30' }
        : { label: 'Conectando…', icon: ShieldAlert, classes: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' }

  const IconoConexion = conexionInfo.icon

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-slate-900 text-white shadow-lg shadow-slate-900/10">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
              <Layers className="size-5 text-emerald-300" />
            </span>
            <div>
              <h1 className="text-lg font-bold tracking-tight">
                <span className="text-white">MillaOps</span>{' '}
                <span className="bg-gradient-to-r from-cyan-300 to-emerald-300 bg-clip-text text-transparent">
                  Hub
                </span>
              </h1>
              <p className="text-xs text-slate-400">Seguimiento de Servicios Última Milla</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Despacho activo */}
            <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/10">
              <Database className="size-4 shrink-0 text-slate-300" />
              <div className="min-w-0">
                <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                  Despacho activo
                </p>
                <p className="text-xs font-semibold tabular-nums">
                  {serviciosActivos.length} órdenes
                </p>
              </div>
            </div>

            {/* Estado de conexión */}
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ring-1',
                conexionInfo.classes,
              )}
              title={conexionInfo.label}
            >
              <IconoConexion className={cn('size-4', conexion === 'conectando' && 'animate-pulse')} />
              {conexionInfo.label}
            </span>

            <button
              type="button"
              onClick={() => setMatrizAbierta(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white ring-1 ring-white/15 transition hover:bg-white/15"
            >
              <SlidersHorizontal className="size-4" />
              Gestionar Matriz
            </button>

            <button
              type="button"
              onClick={() => setPdfAbierto(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-400"
            >
              <FileText className="size-4" />
              Exportar PDF
            </button>

            <button
              type="button"
              onClick={() => void handleSincronizar()}
              disabled={sincronizando || cargando}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={cn('size-4', sincronizando && 'animate-spin')} />
              Sincronizar Asignaciones
            </button>

            <button
              type="button"
              onClick={() => void cargarDatos()}
              disabled={cargando}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white ring-1 ring-white/15 transition hover:bg-white/15 disabled:opacity-50"
            >
              <RefreshCw className={cn('size-4', cargando && 'animate-spin')} />
              Actualizar
            </button>

            {/* Firma del autor (discreta, no invasiva) */}
            <a
              href="https://github.com/elald3ano"
              target="_blank"
              rel="noopener noreferrer"
              title="Diseñado y desarrollado por Daniel Córdoba (@elald3ano)"
              aria-label="Diseñado y desarrollado por Daniel Córdoba (@elald3ano). Abrir GitHub."
              className="group inline-flex items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-2 text-xs ring-1 ring-white/10 transition hover:bg-slate-800 hover:ring-white/20"
            >
              <CodeXml className="size-4 shrink-0 text-slate-400 transition group-hover:text-white" />
              <span className="hidden leading-tight sm:block">
                <span className="block font-semibold text-slate-200">Daniel Córdoba</span>
                <span className="block text-[10px] text-slate-400">
                  Asistente Técnico Distrital
                </span>
              </span>
            </a>
          </div>
        </div>
      </header>

      {/* Contenido */}
      <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 sm:px-6">
        {!isSupabaseConfigured && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
          >
            <ShieldAlert className="mt-0.5 size-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Supabase no está configurado</p>
              <p className="mt-0.5 text-amber-800">
                Copia <code className="rounded bg-amber-100 px-1 font-mono">.env.example</code> a{' '}
                <code className="rounded bg-amber-100 px-1 font-mono">.env</code> y define{' '}
                <code className="rounded bg-amber-100 px-1 font-mono">VITE_SUPABASE_URL</code> y{' '}
                <code className="rounded bg-amber-100 px-1 font-mono">VITE_SUPABASE_ANON_KEY</code>.
                Luego reinicia el servidor de desarrollo.
              </p>
            </div>
          </div>
        )}

        {cargando ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-slate-500">
            <RefreshCw className="size-6 animate-spin" />
            <p className="text-sm">Cargando datos de Supabase…</p>
          </div>
        ) : (
          <>
            {/* Pestañas principales */}
            <nav className="flex w-fit gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200">
              {(
                [
                  { id: 'centro_mando', label: 'Centro de Mando', icon: BarChart3 },
                  { id: 'territorio', label: 'Gestión Territorial', icon: MapIcon },
                  { id: 'cierres', label: 'Auditoría de Cierres', icon: TrendingUp },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setVistaActiva(id)
                    setTecnicoSeleccionadoId(null)
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition',
                    vistaActiva === id
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </nav>

            {vistaActiva === 'centro_mando' ? (
              <AnaliticaDashboard
                servicios={serviciosActivos}
                tecnicos={tecnicos}
                ciudadesActivas={ciudadesActivas}
                procesando={procesando}
                onProcesarReporte={handleProcesar}
                notificar={notificar}
              />
            ) : vistaActiva === 'cierres' ? (
              <AuditoriaCierresDashboard
                serviciosActivos={serviciosActivos}
                reglas={reglas}
                notificar={notificar}
                resultado={resultadoCierres}
                onResultado={setResultadoCierres}
                corteAyerNombre={corteAyerNombre}
                corteHoyNombre={corteHoyNombre}
                onCorteAyerNombre={setCorteAyerNombre}
                onCorteHoyNombre={setCorteHoyNombre}
                fechaCorteAnterior={fechaCorteAnterior}
                fechaCorteActual={fechaCorteActual}
                onFechaCorteAnterior={setFechaCorteAnterior}
                onFechaCorteActual={setFechaCorteActual}
              />
            ) : tecnicoSeleccionado ? (
              <DetalleTecnicoTerritorio
                tecnico={tecnicoSeleccionado}
                reglas={reglas}
                servicios={serviciosActivos}
                ciudadesActivas={ciudadesActivas[tecnicoSeleccionado.id] ?? []}
                onVolver={() => void volverAlDirectorio()}
                notificar={notificar}
                onCambio={refrescarTrasGuardarCuadrilla}
              />
            ) : (
              <DirectorioTecnicos
                tecnicos={tecnicos}
                reglas={reglas}
                ciudadesActivas={ciudadesActivas}
                onSeleccionar={setTecnicoSeleccionadoId}
                notificar={notificar}
                onCreado={handleTecnicoCreado}
              />
            )}
          </>
        )}
      </main>

      <RulesManagerModal
        abierto={matrizAbierta}
        onCerrar={() => setMatrizAbierta(false)}
        reglas={reglas}
        serviciosAbiertos={serviciosActivos}
        onCambio={refrescarReglas}
        notificar={notificar}
        onReaplicar={reaplicarMatriz}
      />

      <PdfExportModal
        abierto={pdfAbierto}
        onCerrar={() => setPdfAbierto(false)}
        servicios={serviciosActivos}
        tecnicos={tecnicos}
        notificar={notificar}
      />

      <ToastContainer toasts={toasts} onDismiss={descartarToast} />
    </div>
  )
}

export default App
