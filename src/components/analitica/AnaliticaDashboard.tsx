import { useMemo, useState } from 'react'
import { BarChart3, MapPin, Upload } from 'lucide-react'
import type { Servicio, Tecnico } from '../../types'
import type { ToastVariant } from '../ToastContainer'
import { ciudadCanonica, esSucursalAutorizada } from '../../lib/zonasPermitidas'
import { MultiSelectFilter, type MultiSelectOpcion } from '../MultiSelectFilter'
import { Modal } from '../Modal'
import { FileUpload } from '../FileUpload'
import { BalanceCuadrillas } from './BalanceCuadrillas'
import { RadarMasivos } from './RadarMasivos'
import { RadarFlotantes } from './RadarFlotantes'
import { ControlCalidad } from './ControlCalidad'
import { RadiografiaTecnico } from './RadiografiaTecnico'

/** Id sintético que representa las órdenes sin técnico asignado. */
const SIN_ASIGNAR_ID = 'sin_asignar'

interface AnaliticaDashboardProps {
  servicios: Servicio[]
  tecnicos: Tecnico[]
  ciudadesActivas: Record<string, string[]>
  procesando: boolean
  onProcesarReporte: (file: File, ciudadFiltro: string | undefined) => Promise<boolean>
  notificar: (mensaje: string, variant?: ToastVariant) => void
}

/**
 * Módulo de Analítica Distrital: inteligencia operativa en tiempo real a partir
 * de `serviciosActivos` y `tecnicos`, sin consultar la base de datos.
 */
export function AnaliticaDashboard({
  servicios,
  tecnicos,
  ciudadesActivas,
  procesando,
  onProcesarReporte,
  notificar,
}: AnaliticaDashboardProps) {
  const [sucursalesSeleccionadas, setSucursalesSeleccionadas] = useState<string[]>([])
  const [tecnicoSeleccionadoId, setTecnicoSeleccionadoId] = useState<string | null>(null)
  // Ciudad de las órdenes sin asignar (solo aplica cuando `tecnicoSeleccionadoId === 'sin_asignar'`).
  const [sinAsignarCiudad, setSinAsignarCiudad] = useState<string | null>(null)
  const [barrioExpandido, setBarrioExpandido] = useState<string | null>(null)
  const [modalCargaAbierto, setModalCargaAbierto] = useState(false)

  // Invariante #2: todo responde al universo de las 27 sucursales autorizadas.
  const serviciosAutorizados = useMemo(
    () => servicios.filter((s) => esSucursalAutorizada(s.ciudad)),
    [servicios],
  )

  // Opciones del multi-select de sucursales (canónicas, con conteo de órdenes).
  const opcionesSucursales = useMemo<MultiSelectOpcion[]>(() => {
    const conteo = new Map<string, number>()
    for (const s of serviciosAutorizados) {
      const canonica = ciudadCanonica(s.ciudad)
      if (!canonica) continue
      conteo.set(canonica, (conteo.get(canonica) ?? 0) + 1)
    }
    return [...conteo.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ciudad, cantidad]) => ({ id: ciudad, label: ciudad, count: cantidad }))
  }, [serviciosAutorizados])

  const serviciosFiltrados = useMemo(() => {
    if (sucursalesSeleccionadas.length === 0) return serviciosAutorizados
    return serviciosAutorizados.filter((s) =>
      sucursalesSeleccionadas.includes(ciudadCanonica(s.ciudad)),
    )
  }, [serviciosAutorizados, sucursalesSeleccionadas])

  const tecnicoSeleccionado = useMemo(() => {
    if (tecnicoSeleccionadoId === SIN_ASIGNAR_ID) {
      return { id: SIN_ASIGNAR_ID, nombre: 'Sin Asignar', activo: true } satisfies Tecnico
    }
    return tecnicos.find((t) => t.id === tecnicoSeleccionadoId) ?? null
  }, [tecnicos, tecnicoSeleccionadoId])

  const serviciosDelTecnico = useMemo(() => {
    if (!tecnicoSeleccionadoId) return []
    if (tecnicoSeleccionadoId === SIN_ASIGNAR_ID) {
      return serviciosFiltrados.filter(
        (s) =>
          s.tecnico_id === null &&
          (!sinAsignarCiudad || ciudadCanonica(s.ciudad) === sinAsignarCiudad),
      )
    }
    return serviciosFiltrados.filter((s) => s.tecnico_id === tecnicoSeleccionadoId)
  }, [serviciosFiltrados, tecnicoSeleccionadoId, sinAsignarCiudad])

  // Conmuta la selección de técnico (clic de nuevo = deseleccionar).
  const toggleTecnico = (id: string) => {
    setBarrioExpandido(null)
    setSinAsignarCiudad(null)
    setTecnicoSeleccionadoId((prev) => (prev === id ? null : id))
  }

  // Selecciona las órdenes sin asignar: global (ciudad null) o de una sucursal.
  const seleccionarSinAsignar = (ciudad: string | null) => {
    setBarrioExpandido(null)
    const yaSeleccionado =
      tecnicoSeleccionadoId === SIN_ASIGNAR_ID && sinAsignarCiudad === ciudad
    if (yaSeleccionado) {
      setTecnicoSeleccionadoId(null)
      setSinAsignarCiudad(null)
    } else {
      setTecnicoSeleccionadoId(SIN_ASIGNAR_ID)
      setSinAsignarCiudad(ciudad)
    }
  }

  const verVistaGlobal = () => {
    setTecnicoSeleccionadoId(null)
    setSinAsignarCiudad(null)
    setBarrioExpandido(null)
  }

  const toggleBarrio = (clave: string) => {
    setBarrioExpandido((prev) => (prev === clave ? null : clave))
  }

  return (
    <section className="space-y-4">
      {/* Barra superior */}
      <div className="flex flex-col gap-3 rounded-2xl bg-slate-900 p-4 text-white shadow-lg ring-1 ring-white/10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
            <BarChart3 className="size-5 text-emerald-300" />
          </span>
          <div>
            <h2 className="text-base font-bold tracking-tight">
              Inteligencia Operativa y Control Distrital
            </h2>
            <p className="text-xs text-slate-400">Analítica en tiempo real del despacho activo</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Multi-select de sucursales con buscador */}
          <div className="w-60">
            <MultiSelectFilter
              label="Sucursales"
              opciones={opcionesSucursales}
              seleccionados={sucursalesSeleccionadas}
              onSeleccionChange={setSucursalesSeleccionadas}
              placeholderTodos="Todas las sucursales"
              icono={MapPin}
            />
          </div>

          {/* Carga rápida del reporte diario */}
          <button
            type="button"
            onClick={() => setModalCargaAbierto(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10 hover:text-white"
          >
            <Upload className="size-3.5" /> Cargar Reporte Sigma
          </button>

          {/* Badge resumen */}
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
            Total {serviciosFiltrados.length} órdenes analizadas
          </span>
        </div>
      </div>

      {/* Drill-down: técnicos (izquierda, 4/12) → radiografía / radar global (derecha, 8/12) */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <BalanceCuadrillas
            servicios={serviciosFiltrados}
            tecnicos={tecnicos}
            ciudadesActivas={ciudadesActivas}
            tecnicoSeleccionadoId={tecnicoSeleccionadoId}
            sinAsignarCiudadSeleccionada={sinAsignarCiudad}
            onToggleTecnico={toggleTecnico}
            onSeleccionarSinAsignar={seleccionarSinAsignar}
          />
        </div>

        <div className="lg:col-span-8">
          {tecnicoSeleccionado ? (
            <RadiografiaTecnico
              key={tecnicoSeleccionado.id}
              tecnico={tecnicoSeleccionado}
              servicios={serviciosDelTecnico}
              barrioExpandido={barrioExpandido}
              onToggleBarrio={toggleBarrio}
              onVerVistaGlobal={verVistaGlobal}
              notificar={notificar}
            />
          ) : (
            <RadarMasivos servicios={serviciosFiltrados} />
          )}
        </div>
      </div>

      {/* Cards complementarias */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RadarFlotantes servicios={serviciosFiltrados} />
        <ControlCalidad servicios={serviciosFiltrados} />
      </div>

      {/* Modal de carga rápida del reporte diario */}
      <Modal
        abierto={modalCargaAbierto}
        onCerrar={() => setModalCargaAbierto(false)}
        titulo="Cargar Reporte Sigma"
        descripcion="Procesa el nuevo Excel diario y actualiza el despacho en vivo."
        anchoMaximo="max-w-lg"
      >
        <FileUpload
          procesando={procesando}
          onProcesar={onProcesarReporte}
          onExito={() => setModalCargaAbierto(false)}
        />
      </Modal>
    </section>
  )
}
