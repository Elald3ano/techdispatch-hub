import { useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  Map as MapIcon,
  Search,
  UserPlus,
  UserRound,
} from 'lucide-react'
import { limpiarTexto } from '../../lib/normalizer'
import { cn } from '../../lib/utils'
import { Modal } from '../Modal'
import { crearTecnico, importarMatrizDesdeExcel } from '../../services/supabaseService'
import type { ReglaConTecnico, Tecnico } from '../../types'
import type { ToastVariant } from '../ToastContainer'

interface DirectorioTecnicosProps {
  tecnicos: Tecnico[]
  reglas: ReglaConTecnico[]
  ciudadesActivas: Record<string, string[]>
  onSeleccionar: (tecnicoId: string) => void
  notificar: (mensaje: string, variant?: ToastVariant) => void
  /** Se invoca tras crear un técnico para refrescar y seleccionarlo. */
  onCreado: (tecnico: Tecnico) => Promise<void>
  /** Se invoca tras importar la matriz por Excel para refrescar reglas y técnicos. */
  onCambio?: () => Promise<void>
}

type FiltroRapido = 'todos' | 'conBarrios' | 'sinBarrios'

/** ID corto legible a partir del UUID. */
function idCorto(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

/** Directorio maestro de técnicos (tabla oscura estilo navy). */
export function DirectorioTecnicos({
  tecnicos,
  reglas,
  ciudadesActivas,
  onSeleccionar,
  notificar,
  onCreado,
  onCambio,
}: DirectorioTecnicosProps) {
  const [busqueda, setBusqueda] = useState('')
  const [filtro, setFiltro] = useState<FiltroRapido>('todos')

  // Formulario del modal "Nuevo Técnico".
  const [modalNuevo, setModalNuevo] = useState(false)
  const [formNombre, setFormNombre] = useState('')
  const [formTelefono, setFormTelefono] = useState('')
  const [formDocumento, setFormDocumento] = useState('')
  const [creando, setCreando] = useState(false)

  // Importación masiva de la matriz de asignación desde Excel.
  const [importando, setImportando] = useState(false)
  const archivoMatrizRef = useRef<HTMLInputElement>(null)

  const stats = useMemo(() => {
    const barrios = new Map<string, Set<string>>()
    const ciudades = new Map<string, Set<string>>()

    for (const regla of reglas) {
      if (!regla.barrio) continue
      const claveBarrio = `${limpiarTexto(regla.ciudad)}|${limpiarTexto(regla.barrio)}`

      const setBarrios = barrios.get(regla.tecnico_id) ?? new Set<string>()
      setBarrios.add(claveBarrio)
      barrios.set(regla.tecnico_id, setBarrios)

      const setCiudades = ciudades.get(regla.tecnico_id) ?? new Set<string>()
      setCiudades.add(limpiarTexto(regla.ciudad))
      ciudades.set(regla.tecnico_id, setCiudades)
    }

    return { barrios, ciudades }
  }, [reglas])

  const filas = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return tecnicos
      .map((tecnico) => {
        const barriosCount = stats.barrios.get(tecnico.id)?.size ?? 0
        const ciudadesRegistradas = ciudadesActivas[tecnico.id]
        const ciudadesCount =
          ciudadesRegistradas && ciudadesRegistradas.length > 0
            ? ciudadesRegistradas.length
            : (stats.ciudades.get(tecnico.id)?.size ?? 0)

        return { tecnico, barriosCount, ciudadesCount }
      })
      .filter(({ tecnico, barriosCount }) => {
        if (filtro === 'conBarrios' && barriosCount === 0) return false
        if (filtro === 'sinBarrios' && barriosCount > 0) return false

        if (q) {
          const coincide =
            tecnico.nombre.toLowerCase().includes(q) ||
            tecnico.id.toLowerCase().includes(q)
          if (!coincide) return false
        }
        return true
      })
      .sort((a, b) => a.tecnico.nombre.localeCompare(b.tecnico.nombre))
  }, [tecnicos, stats, ciudadesActivas, busqueda, filtro])

  const conteo = {
    todos: tecnicos.length,
    conBarrios: tecnicos.filter((t) => (stats.barrios.get(t.id)?.size ?? 0) > 0).length,
    sinBarrios: tecnicos.filter((t) => (stats.barrios.get(t.id)?.size ?? 0) === 0).length,
  }

  const pestañas: Array<{ id: FiltroRapido; label: string }> = [
    { id: 'todos', label: `Todos (${conteo.todos})` },
    { id: 'conBarrios', label: `Con barrios asignados (${conteo.conBarrios})` },
    { id: 'sinBarrios', label: `Sin barrios (${conteo.sinBarrios})` },
  ]

  function abrirModalNuevo() {
    setFormNombre('')
    setFormTelefono('')
    setFormDocumento('')
    setModalNuevo(true)
  }

  async function handleCrear() {
    const nombre = formNombre.trim()
    if (!nombre) {
      notificar('El nombre completo es obligatorio.', 'error')
      return
    }
    setCreando(true)

    let nuevo: Tecnico
    try {
      nuevo = await crearTecnico({
        nombre,
        telefono: formTelefono.trim() || undefined,
        documento: formDocumento.trim() || undefined,
      })
    } catch (e) {
      notificar(e instanceof Error ? e.message : 'No se pudo crear el técnico.', 'error')
      setCreando(false)
      return
    }

    setCreando(false)
    setModalNuevo(false)
    notificar(`Técnico "${nuevo.nombre}" creado correctamente.`, 'success')
    await onCreado(nuevo)
  }

  async function handleImportarMatriz(file: File | undefined) {
    if (!file) return
    setImportando(true)
    try {
      // xlsx es pesado: se importa bajo demanda.
      const { parsearMatrizExcel } = await import('../../services/excelParser')
      const filas = await parsearMatrizExcel(file)
      if (filas.length === 0) {
        notificar('No se encontraron filas válidas en la matriz.', 'error')
        return
      }
      const resultado = await importarMatrizDesdeExcel(filas)
      await onCambio?.()
      notificar(
        `${resultado.tecnicosCreados} técnicos y ${resultado.reglasCreadas} reglas importadas con éxito.`,
        'success',
      )
    } catch (e) {
      notificar(e instanceof Error ? e.message : 'No se pudo importar la matriz.', 'error')
    } finally {
      setImportando(false)
    }
  }

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900 shadow-xl shadow-slate-900/20">
        {/* Barra superior */}
        <div className="flex flex-col gap-3 border-b border-slate-700/60 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar técnico o ID…"
              aria-label="Buscar técnico"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 pr-3 pl-9 text-sm text-slate-100 shadow-sm outline-none transition placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-lg bg-slate-800/80 p-1">
              {pestañas.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFiltro(id)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium transition',
                    filtro === id
                      ? 'bg-slate-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => archivoMatrizRef.current?.click()}
              disabled={importando}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importando ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="size-4" />
              )}
              {importando ? 'Importando…' : 'Importar Matriz (Excel)'}
            </button>
            <input
              ref={archivoMatrizRef}
              type="file"
              accept=".xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                const archivo = e.target.files?.[0]
                e.target.value = ''
                void handleImportarMatriz(archivo)
              }}
            />

            <button
              type="button"
              onClick={abrirModalNuevo}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-400"
            >
              <UserPlus className="size-4" />
              Nuevo Técnico
            </button>
          </div>
        </div>

        {/* Tabla */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-700/60 bg-slate-800/60 text-xs font-semibold tracking-wide text-slate-400 uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  ID / Cédula
                </th>
                <th scope="col" className="px-4 py-3">
                  Técnico
                </th>
                <th scope="col" className="px-4 py-3">
                  Sucursales / Ciudades
                </th>
                <th scope="col" className="px-4 py-3">
                  Barrios Asignados
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/40">
              {filas.map(({ tecnico, barriosCount, ciudadesCount }) => (
                <tr
                  key={tecnico.id}
                  onClick={() => onSeleccionar(tecnico.id)}
                  className="cursor-pointer transition hover:bg-slate-800/60"
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {tecnico.documento || idCorto(tecnico.id)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-full bg-slate-700/60 text-slate-300">
                        <UserRound className="size-3.5" />
                      </span>
                      <span className="font-medium text-slate-100">{tecnico.nombre}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-slate-300">
                      <MapIcon className="size-3.5 text-slate-500" />
                      {ciudadesCount} {ciudadesCount === 1 ? 'ciudad' : 'ciudades'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300 tabular-nums">
                    {barriosCount} {barriosCount === 1 ? 'barrio' : 'barrios'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="ml-auto size-4 text-slate-600" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filas.length === 0 && (
            <div className="px-4 py-14 text-center">
              <p className="text-sm font-medium text-slate-300">Sin resultados</p>
              <p className="mt-1 text-xs text-slate-500">
                No hay técnicos que coincidan con el filtro o la búsqueda.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Modal Nuevo Técnico */}
      <Modal
        abierto={modalNuevo}
        onCerrar={() => {
          if (!creando) setModalNuevo(false)
        }}
        titulo="Nuevo Técnico"
        descripcion="Registra un nuevo técnico para empezar a asignarle ciudades y barrios."
        anchoMaximo="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setModalNuevo(false)}
              disabled={creando}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleCrear()}
              disabled={creando}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {creando && <Loader2 className="size-4 animate-spin" />}
              Crear Técnico
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label
              htmlFor="nuevo-nombre"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Nombre Completo <span className="text-red-500">*</span>
            </label>
            <input
              id="nuevo-nombre"
              type="text"
              value={formNombre}
              onChange={(e) => setFormNombre(e.target.value)}
              placeholder="Ej: Juan Pérez"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCrear()
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            />
          </div>

          <div>
            <label
              htmlFor="nuevo-telefono"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Teléfono / Celular
            </label>
            <input
              id="nuevo-telefono"
              type="tel"
              value={formTelefono}
              onChange={(e) => setFormTelefono(e.target.value)}
              placeholder="Ej: 300 123 4567"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCrear()
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            />
          </div>

          <div>
            <label
              htmlFor="nuevo-documento"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Cédula / Documento
            </label>
            <input
              id="nuevo-documento"
              type="text"
              value={formDocumento}
              onChange={(e) => setFormDocumento(e.target.value)}
              placeholder="Ej: 1234567890"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCrear()
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            />
          </div>
        </div>
      </Modal>
    </>
  )
}
