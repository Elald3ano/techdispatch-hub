import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Bike,
  Check,
  CheckSquare,
  Loader2,
  MapPin,
  Save,
  Search,
  Settings2,
  Square,
  Truck,
} from 'lucide-react'
import { Modal } from '../Modal'
import {
  asignarCuadrilla,
  guardarCiudadesActivasTecnico,
} from '../../services/supabaseService'
import { limpiarBarrio, limpiarPrefijoNodo, limpiarTexto } from '../../lib/normalizer'
import { TIPOS_SERVICIO_OFICIALES, TOTAL_TIPOS_SERVICIO } from '../../lib/tiposServicio'
import { ciudadCanonica } from '../../lib/zonasPermitidas'
import { cn } from '../../lib/utils'
import type { ModalidadCuadrilla, ReglaConTecnico, Servicio, Tecnico } from '../../types'
import type { ToastVariant } from '../ToastContainer'

interface DetalleTecnicoTerritorioProps {
  tecnico: Tecnico
  reglas: ReglaConTecnico[]
  servicios: Servicio[]
  ciudadesActivas: string[]
  onVolver: () => void
  notificar: (mensaje: string, variant?: ToastVariant) => void
  /** Refresca reglas y servicios en el padre tras guardar una cuadrilla. */
  onCambio?: () => Promise<void>
}

// Estado editable de la cuadrilla de una ciudad.
interface ConfigLocal {
  modalidad: ModalidadCuadrilla
  servicios: Set<string>
  barrios: Set<string>
}

// Traspaso pendiente de confirmación (barrio ajeno).
interface TransferenciaPendiente {
  ciudad: string
  barrio: string
  dueno: string
}

function configVacia(): ConfigLocal {
  return { modalidad: 'general', servicios: new Set(), barrios: new Set() }
}

/**
 * Deriva la configuración inicial de cada ciudad a partir de las reglas del
 * técnico: reglas `tipo_servicio != null` → flotante; `tipo_servicio == null`
 * (prioridad 2) → general. Los barrios se normalizan al original visible en el
 * tablero para evitar desajustes por tildes/espacios.
 */
function derivarConfigs(
  reglas: ReglaConTecnico[],
  tecnicoId: string,
  barriosPorCiudad: Map<string, Map<string, string>>,
): Record<string, ConfigLocal> {
  const porCiudad = new Map<
    string,
    { general: Set<string>; flotante: Set<string>; servicios: Set<string> }
  >()

  for (const r of reglas) {
    if (r.tecnico_id !== tecnicoId || !r.barrio) continue
    const canonica = ciudadCanonica(r.ciudad)
    if (!canonica) continue
    const ciudadKey = limpiarTexto(canonica)
    const barrioKey = limpiarBarrio(r.barrio)
    const original =
      barriosPorCiudad.get(ciudadKey)?.get(barrioKey) ?? limpiarPrefijoNodo(r.barrio)

    let grupo = porCiudad.get(canonica)
    if (!grupo) {
      grupo = { general: new Set(), flotante: new Set(), servicios: new Set() }
      porCiudad.set(canonica, grupo)
    }
    if (r.tipo_servicio) {
      grupo.servicios.add(r.tipo_servicio)
      grupo.flotante.add(original)
    } else {
      grupo.general.add(original)
    }
  }

  const resultado: Record<string, ConfigLocal> = {}
  for (const [ciudad, grupo] of porCiudad) {
    resultado[ciudad] =
      grupo.servicios.size > 0
        ? { modalidad: 'flotante', servicios: grupo.servicios, barrios: grupo.flotante }
        : { modalidad: 'general', servicios: new Set(), barrios: grupo.general }
  }
  return resultado
}

/** Tablero de asignación por cuadrilla (general o flotante) para un técnico. */
export function DetalleTecnicoTerritorio({
  tecnico,
  reglas,
  servicios,
  ciudadesActivas,
  onVolver,
  notificar,
  onCambio,
}: DetalleTecnicoTerritorioProps) {
  const [modalCiudades, setModalCiudades] = useState(false)
  const [busquedaCiudad, setBusquedaCiudad] = useState('')
  const [guardandoCiudades, setGuardandoCiudades] = useState(false)
  const [guardandoCuadrilla, setGuardandoCuadrilla] = useState<string | null>(null)
  const [busquedaServicio, setBusquedaServicio] = useState<Record<string, string>>({})
  const [transferencia, setTransferencia] = useState<TransferenciaPendiente | null>(null)

  // Todas las ciudades conocidas (reglas + servicios), en forma canónica.
  const todasLasCiudades = useMemo(() => {
    const set = new Set<string>()
    const agregar = (ciudad: string) => {
      const canonica = ciudadCanonica(ciudad)
      if (canonica) set.add(canonica)
    }
    for (const r of reglas) agregar(r.ciudad)
    for (const s of servicios) agregar(s.ciudad)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [reglas, servicios])

  // Barrios por ciudad: Map<limpiarTexto(ciudad), Map<limpiarBarrio(barrio), nombreLegible>>.
  // La clave canónica `limpiarBarrio` fusiona variantes de nodo comercial
  // (ej. "JAMD-01 VILLA TATIANA" y "JAMD-02 VILLA TATIANA" → "VILLA TATIANA").
  const barriosPorCiudad = useMemo(() => {
    const mapa = new Map<string, Map<string, string>>()
    const agregar = (ciudad: string, barrio: string) => {
      // Canonicaliza la ciudad (Invariante #2) para que alias como "Toro"
      // o "La Union" se unifiquen con "Toro Valle"/"La Union Valle" y los
      // barrios de reglas y órdenes converjan en una única pestaña.
      const canonica = ciudadCanonica(ciudad)
      const ck = limpiarTexto(canonica)
      const bk = limpiarBarrio(barrio)
      if (!ck || !bk) return
      const inner = mapa.get(ck) ?? new Map<string, string>()
      if (!inner.has(bk)) inner.set(bk, limpiarPrefijoNodo(barrio))
      mapa.set(ck, inner)
    }
    for (const r of reglas) {
      if (r.barrio) agregar(r.ciudad, r.barrio)
    }
    for (const s of servicios) {
      agregar(s.ciudad, s.barrio)
    }
    return mapa
  }, [reglas, servicios])

  // Dueño general actual por barrio (reglas P2 de OTROS técnicos), para avisar.
  const duenoGeneralAjeno = useMemo(() => {
    const mapa = new Map<string, string>()
    for (const r of reglas) {
      if (!r.barrio || r.tipo_servicio) continue
      if (r.tecnico_id === tecnico.id) continue
      const clave = `${limpiarTexto(r.ciudad)}|${limpiarBarrio(r.barrio)}`
      if (!mapa.has(clave)) mapa.set(clave, r.tecnico.nombre)
    }
    return mapa
  }, [reglas, tecnico.id])

  // Configuración editable por ciudad (inicializada desde las reglas).
  const [configs, setConfigs] = useState<Record<string, ConfigLocal>>(() =>
    derivarConfigs(reglas, tecnico.id, barriosPorCiudad),
  )

  // Ciudades activas locales (fallback: ciudades donde tiene reglas).
  const [ciudadesActivasLocales, setCiudadesActivasLocales] = useState<Set<string>>(() => {
    const activas = new Set<string>()
    for (const c of ciudadesActivas) {
      const canonica = ciudadCanonica(c)
      if (canonica) activas.add(canonica)
    }
    if (activas.size > 0) return activas
    // Fallback: ciudades donde tiene reglas.
    const set = new Set<string>()
    for (const r of reglas) {
      if (r.tecnico_id === tecnico.id) {
        const canonica = ciudadCanonica(r.ciudad)
        if (canonica) set.add(canonica)
      }
    }
    return set
  })

  function actualizarConfig(ciudad: string, updater: (prev: ConfigLocal) => ConfigLocal) {
    setConfigs((prev) => {
      const actual = prev[ciudad] ?? configVacia()
      return { ...prev, [ciudad]: updater(actual) }
    })
  }

  function toggleModalidad(ciudad: string, modalidad: ModalidadCuadrilla) {
    actualizarConfig(ciudad, (c) => ({ ...c, modalidad }))
  }

  function toggleServicio(ciudad: string, servicio: string) {
    actualizarConfig(ciudad, (c) => {
      const servicios = new Set(c.servicios)
      if (servicios.has(servicio)) servicios.delete(servicio)
      else servicios.add(servicio)
      return { ...c, servicios }
    })
  }

  function toggleBarrio(ciudad: string, barrio: string) {
    actualizarConfig(ciudad, (c) => {
      const barrios = new Set(c.barrios)
      if (barrios.has(barrio)) barrios.delete(barrio)
      else barrios.add(barrio)
      return { ...c, barrios }
    })
  }

  function solicitarTransferencia(ciudad: string, barrio: string, dueno: string) {
    setTransferencia({ ciudad, barrio, dueno })
  }

  function confirmarTransferencia() {
    if (!transferencia) return
    toggleBarrio(transferencia.ciudad, transferencia.barrio)
    setTransferencia(null)
  }

  function marcarTodosServicios(ciudad: string, todos: boolean) {
    actualizarConfig(ciudad, (c) => ({
      ...c,
      servicios: todos ? new Set<string>(TIPOS_SERVICIO_OFICIALES) : new Set<string>(),
    }))
  }

  async function guardarCuadrilla(ciudad: string) {
    const config = configs[ciudad] ?? configVacia()
    if (config.modalidad === 'flotante' && config.servicios.size === 0) {
      notificar('Selecciona al menos un tipo de servicio para la cuadrilla flotante.', 'error')
      return
    }
    setGuardandoCuadrilla(ciudad)
    try {
      const totalReglas = await asignarCuadrilla(tecnico.id, ciudad, {
        modalidad: config.modalidad,
        servicios: [...config.servicios],
        barrios: [...config.barrios],
      })
      await onCambio?.()
      notificar(
        `Se guardaron ${totalReglas} reglas y se actualizaron los servicios en pantalla.`,
        'success',
      )
    } catch (e) {
      notificar(
        e instanceof Error ? e.message : 'No se pudo guardar la cuadrilla.',
        'error',
      )
    } finally {
      setGuardandoCuadrilla(null)
    }
  }

  async function guardarCiudades() {
    setGuardandoCiudades(true)
    try {
      await guardarCiudadesActivasTecnico(tecnico.id, [...ciudadesActivasLocales])
      setModalCiudades(false)
      notificar('Ciudades activas actualizadas.', 'success')
    } catch (e) {
      notificar(e instanceof Error ? e.message : 'No se pudo guardar las ciudades.', 'error')
    } finally {
      setGuardandoCiudades(false)
    }
  }

  function toggleCiudad(ciudad: string) {
    setCiudadesActivasLocales((prev) => {
      const next = new Set(prev)
      if (next.has(ciudad)) next.delete(ciudad)
      else next.add(ciudad)
      return next
    })
  }

  const ciudadesOrdenadas = [...ciudadesActivasLocales].sort((a, b) => a.localeCompare(b))
  const ciudadesFiltradas = todasLasCiudades.filter((c) =>
    c.toLowerCase().includes(busquedaCiudad.trim().toLowerCase()),
  )

  return (
    <div className="space-y-5">
      {/* Cabecera */}
      <div className="rounded-2xl border border-slate-700/60 bg-slate-900 p-5 shadow-xl shadow-slate-900/20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onVolver}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
            >
              <ArrowLeft className="size-4" /> Volver
            </button>
            <div>
              <h2 className="text-lg font-bold text-white">{tecnico.nombre}</h2>
              <p className="text-xs text-slate-400">
                {ciudadesOrdenadas.length}{' '}
                {ciudadesOrdenadas.length === 1 ? 'ciudad activa' : 'ciudades activas'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setModalCiudades(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-600"
          >
            <Settings2 className="size-4" /> Gestionar Ciudades
          </button>
        </div>
      </div>

      {/* Tableros por ciudad */}
      {ciudadesOrdenadas.length === 0 ? (
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900 px-5 py-16 text-center">
          <p className="text-sm font-medium text-slate-300">Sin ciudades activas</p>
          <p className="mt-1 text-xs text-slate-500">
            Activa ciudades con el botón "Gestionar Ciudades" para trabajar su territorio.
          </p>
        </div>
      ) : (
        ciudadesOrdenadas.map((ciudad) => {
          const ciudadKey = limpiarTexto(ciudad)
          const barrios = barriosPorCiudad.get(ciudadKey) ?? new Map<string, string>()
          const config = configs[ciudad] ?? configVacia()
          const barriosLista = [...barrios.values()].sort((a, b) => a.localeCompare(b))
          const total = barriosLista.length
          const seleccionados = config.barrios.size
          // Servicios del catálogo oficial efectivamente marcados.
          const serviciosSeleccionados = TIPOS_SERVICIO_OFICIALES.filter((s) =>
            config.servicios.has(s),
          )
          // Servicios personalizados (reglas históricas fuera del catálogo).
          const oficiales = new Set<string>(TIPOS_SERVICIO_OFICIALES)
          const serviciosPersonalizados = [...config.servicios]
            .filter((s) => !oficiales.has(s))
            .sort((a, b) => a.localeCompare(b))
          const queryServicio = limpiarTexto(busquedaServicio[ciudad] ?? '')
          const serviciosFiltrados = TIPOS_SERVICIO_OFICIALES.filter(
            (s) => !queryServicio || limpiarTexto(s).includes(queryServicio),
          )
          const guardando = guardandoCuadrilla === ciudad

          return (
            <div
              key={ciudad}
              className="rounded-2xl border border-slate-700/60 bg-slate-900 p-5 shadow-xl shadow-slate-900/20"
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MapPin className="size-4 text-slate-500" />
                  <h3 className="text-base font-semibold text-white">{ciudad}</h3>
                </div>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ring-1',
                    config.modalidad === 'flotante'
                      ? 'bg-violet-500/10 text-violet-300 ring-violet-500/40'
                      : 'bg-sky-500/10 text-sky-300 ring-sky-500/40',
                  )}
                >
                  {config.modalidad === 'flotante' ? 'Flotante · Moto' : 'General · Carro'}
                </span>
              </div>

              {/* Selector de modalidad */}
              <p className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Modalidad de cuadrilla
              </p>
              <div className="mb-4 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => toggleModalidad(ciudad, 'general')}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition',
                    config.modalidad === 'general'
                      ? 'border-sky-500 bg-sky-500/10 text-sky-200'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800',
                  )}
                >
                  <Truck className="size-4 shrink-0" />
                  <span>
                    Todos los servicios
                    <span className="block text-[11px] font-normal text-slate-500">
                      Cuadrilla General / Carro
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleModalidad(ciudad, 'flotante')}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition',
                    config.modalidad === 'flotante'
                      ? 'border-violet-500 bg-violet-500/10 text-violet-200'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800',
                  )}
                >
                  <Bike className="size-4 shrink-0" />
                  <span>
                    Servicios específicos
                    <span className="block text-[11px] font-normal text-slate-500">
                      Cuadrilla Flotante / Moto
                    </span>
                  </span>
                </button>
              </div>

              {/* Servicios (solo flotante) */}
              {config.modalidad === 'flotante' && (
                <div className="mb-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold tracking-wide text-violet-400 uppercase">
                      Tipos de servicio que atiende
                    </p>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1',
                        serviciosSeleccionados.length > 0
                          ? 'bg-violet-500/15 text-violet-200 ring-violet-500/40'
                          : 'bg-slate-800 text-slate-400 ring-slate-700',
                      )}
                    >
                      {serviciosSeleccionados.length} de {TOTAL_TIPOS_SERVICIO} seleccionados
                    </span>
                  </div>

                  {/* Barra de control */}
                  <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" />
                      <input
                        type="search"
                        value={busquedaServicio[ciudad] ?? ''}
                        onChange={(e) =>
                          setBusquedaServicio((prev) => ({ ...prev, [ciudad]: e.target.value }))
                        }
                        placeholder="Filtrar servicios (ej. onu, clave, router...)"
                        aria-label="Filtrar tipos de servicio"
                        className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 pr-3 pl-9 text-xs text-slate-200 outline-none transition placeholder:text-slate-500 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => marcarTodosServicios(ciudad, true)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-700"
                      >
                        <CheckSquare className="size-3.5" /> Marcar Todos
                      </button>
                      <button
                        type="button"
                        onClick={() => marcarTodosServicios(ciudad, false)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-700"
                      >
                        <Square className="size-3.5" /> Desmarcar Todos
                      </button>
                    </div>
                  </div>

                  {/* Área de checkboxes */}
                  <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950/40 p-2">
                    {serviciosFiltrados.length === 0 ? (
                      <p className="py-6 text-center text-xs text-slate-500">
                        Sin coincidencias para "{busquedaServicio[ciudad] ?? ''}".
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-3">
                        {serviciosFiltrados.map((servicio) => {
                          const activo = config.servicios.has(servicio)
                          return (
                            <div
                              key={servicio}
                              role="checkbox"
                              aria-checked={activo}
                              tabIndex={0}
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                toggleServicio(ciudad, servicio)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === ' ' || e.key === 'Enter') {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  toggleServicio(ciudad, servicio)
                                }
                              }}
                              className={cn(
                                'flex cursor-pointer select-none items-center gap-2.5 rounded-lg border p-2 transition-colors',
                                activo
                                  ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
                                  : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:bg-slate-800/60',
                              )}
                            >
                              {/* Caja visual personalizada de checkbox, sin foco invasivo */}
                              <div
                                className={cn(
                                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all',
                                  activo
                                    ? 'border-violet-500 bg-violet-600'
                                    : 'border-slate-600 bg-slate-950',
                                )}
                              >
                                {activo && (
                                  <Check className="h-3 w-3 text-white" strokeWidth={3} />
                                )}
                              </div>

                              <span className="text-xs font-medium leading-tight">
                                {servicio}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Servicios históricos fuera del catálogo oficial */}
                  {serviciosPersonalizados.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 text-[11px] font-semibold tracking-wide text-amber-400 uppercase">
                        Otros servicios ya asignados (fuera del catálogo)
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {serviciosPersonalizados.map((servicio) => (
                          <button
                            key={servicio}
                            type="button"
                            onClick={() => toggleServicio(ciudad, servicio)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200 transition hover:bg-amber-500/20"
                          >
                            <CheckSquare className="size-3" />
                            {servicio}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tablero de barrios */}
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  Barrios que cubre
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      actualizarConfig(ciudad, (c) => ({ ...c, barrios: new Set(barriosLista) }))
                    }
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800"
                  >
                    Marcar Todos
                  </button>
                  <button
                    type="button"
                    onClick={() => actualizarConfig(ciudad, (c) => ({ ...c, barrios: new Set() }))}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800"
                  >
                    Limpiar
                  </button>
                </div>
              </div>

              {barriosLista.length === 0 ? (
                <p className="text-xs text-slate-600">
                  No hay barrios registrados en esta ciudad.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {barriosLista.map((barrio) => {
                    const seleccionado = config.barrios.has(barrio)
                    const ajeno = duenoGeneralAjeno.get(`${ciudadKey}|${limpiarBarrio(barrio)}`)
                    return (
                      <button
                        key={barrio}
                        type="button"
                        title={
                          ajeno !== undefined && !seleccionado
                            ? `Dueño general actual: ${ajeno}`
                            : undefined
                        }
                        onClick={() => {
                          // En modo general (carro), un barrio de otro carro exige
                          // confirmación de traspaso (1 barrio = 1 carro). En modo
                          // flotante (moto), el clic solo marca/desmarca el chip; el
                          // nombre del carro es únicamente informativo (coexistencia).
                          if (
                            config.modalidad === 'general' &&
                            ajeno !== undefined &&
                            !seleccionado
                          ) {
                            solicitarTransferencia(ciudad, barrio, ajeno)
                          } else {
                            toggleBarrio(ciudad, barrio)
                          }
                        }}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                          seleccionado
                            ? config.modalidad === 'flotante'
                              ? 'border-violet-500 bg-violet-500/20 text-violet-200 hover:bg-violet-500/30'
                              : 'border-emerald-500 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                            : ajeno !== undefined
                              ? 'border-sky-500/50 bg-slate-800 text-slate-400 hover:bg-sky-500/10'
                              : 'border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700',
                        )}
                      >
                        {barrio}
                        {ajeno !== undefined && !seleccionado && (
                          <span className="rounded-full bg-sky-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200">
                            {ajeno}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-3">
                <p className="text-xs text-slate-500">
                  {seleccionados} de {total} barrios seleccionados
                </p>
                <button
                  type="button"
                  onClick={() => void guardarCuadrilla(ciudad)}
                  disabled={guardando}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {guardando ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  Guardar cuadrilla
                </button>
              </div>
            </div>
          )
        })
      )}

      {/* Modal Gestionar Ciudades */}
      <Modal
        abierto={modalCiudades}
        onCerrar={() => setModalCiudades(false)}
        titulo="Gestionar Ciudades"
        descripcion="Activa o desactiva las ciudades que se muestran en el tablero de este técnico."
        anchoMaximo="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setModalCiudades(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void guardarCiudades()}
              disabled={guardandoCiudades}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {guardandoCiudades && <Loader2 className="size-4 animate-spin" />}
              Guardar
            </button>
          </>
        }
      >
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={busquedaCiudad}
            onChange={(e) => setBusquedaCiudad(e.target.value)}
            placeholder="Buscar ciudad…"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
        </div>

        <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
          {ciudadesFiltradas.map((ciudad) => {
            const activa = ciudadesActivasLocales.has(ciudad)
            return (
              <li key={ciudad}>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50">
                  <span className="text-sm text-slate-800">{ciudad}</span>
                  <span className="relative inline-flex shrink-0 items-center">
                    <input
                      type="checkbox"
                      checked={activa}
                      onChange={() => toggleCiudad(ciudad)}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-emerald-500',
                        'peer-focus-visible:ring-2 peer-focus-visible:ring-slate-400 peer-focus-visible:ring-offset-2',
                      )}
                    />
                    <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
                  </span>
                </label>
              </li>
            )
          })}
        </ul>

        {ciudadesFiltradas.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-500">Sin coincidencias.</p>
        )}
      </Modal>

      {/* Modal Confirmar Transferencia de Barrio */}
      <Modal
        abierto={transferencia !== null}
        onCerrar={() => setTransferencia(null)}
        titulo="⚠️ Confirmar Transferencia de Barrio"
        anchoMaximo="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setTransferencia(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmarTransferencia}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-400"
            >
              Sí, Transferir
            </button>
          </>
        }
      >
        {transferencia && (
          <p className="text-sm leading-relaxed text-slate-700">
            El barrio <strong className="text-slate-900">{transferencia.barrio}</strong>{' '}
            pertenece actualmente a{' '}
            <strong className="text-slate-900">{transferencia.dueno}</strong>. ¿Confirmas que
            deseas transferir la cobertura general a{' '}
            <strong className="text-slate-900">{tecnico.nombre}</strong>?
          </p>
        )}
      </Modal>
    </div>
  )
}
