import { supabase } from '../lib/supabase'
import { aplicarMatrizAsignacion, calcularPrioridad } from './assignmentEngine'
import { limpiarBarrio, limpiarTexto } from '../lib/normalizer'
import { ciudadCanonica, esSucursalAutorizada } from '../lib/zonasPermitidas'
import type { Database } from '../types/database'
import type {
  ConfigCuadrilla,
  FilaMatrizImport,
  NuevaRegla,
  ReglaAsignacion,
  ReglaConTecnico,
  Servicio,
  ServicioNuevo,
  Tecnico,
} from '../types'

type TecnicoRow = Database['public']['Tables']['tecnicos']['Row']
type ReglaRow = Database['public']['Tables']['reglas_asignacion']['Row']
type ServicioRow = Database['public']['Tables']['servicios']['Row']
type AuditoriaCierresRow = Database['public']['Tables']['auditorias_cierres']['Row']
type AuditoriaCierresInsert = Database['public']['Tables']['auditorias_cierres']['Insert']

// Supabase limita el payload de una inserción; se particiona en lotes de 500.
const TAMANO_LOTE_INSERCION = 500
// Lote de actualización masiva para la reasignación de servicios.
const TAMANO_LOTE_ACTUALIZACION = 200
// PostgREST trunca las LECTURAS a 1.000 filas por defecto; se pagina por lotes.
const TAMANO_PAGINA_LECTURA = 1000

/**
 * Lee TODAS las filas de una consulta paginando con `.range()`.
 *
 * Supabase/PostgREST devuelve como máximo 1.000 filas por petición, por lo que
 * una lectura `select('*')` sin paginar ocultaba silenciosamente el resto de la
 * matriz (p. ej. las cuadrillas flotantes de un técnico), mostrando datos
 * incompletos tras recargar. Esta helper recorre todas las páginas y las une.
 */
async function leerTodasLasFilas<T>(
  consulta: (desde: number, hasta: number) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>,
): Promise<
  { data: T[]; error: null } | { data: null; error: { message: string } }
> {
  const filas: T[] = []
  for (let desde = 0; ; desde += TAMANO_PAGINA_LECTURA) {
    const { data, error } = await consulta(desde, desde + TAMANO_PAGINA_LECTURA - 1)
    if (error) return { data: null, error }
    if (!data || data.length === 0) break
    filas.push(...data)
    if (data.length < TAMANO_PAGINA_LECTURA) break
  }
  return { data: filas, error: null }
}

function mapTecnico(row: TecnicoRow): Tecnico {
  return {
    id: row.id,
    nombre: row.nombre,
    telefono: row.telefono ?? undefined,
    documento: row.documento ?? undefined,
    activo: row.activo,
  }
}

function mapServicio(row: ServicioRow): Servicio {
  return {
    id: row.id,
    lote_id: row.lote_id,
    numero_orden: row.numero_orden,
    ciudad: row.ciudad,
    barrio: row.barrio,
    direccion: row.direccion ?? undefined,
    tipo_servicio: row.tipo_servicio,
    nombre_cliente: row.nombre_cliente ?? undefined,
    telefono_cliente: row.telefono_cliente ?? undefined,
    referencia_pago: row.referencia_pago ?? undefined,
    identificacion: row.identificacion ?? undefined,
    estado_sigma: row.estado_sigma ?? undefined,
    fecha_creacion: row.fecha_creacion,
    dias_antiguedad: row.dias_antiguedad,
    tecnico_id: row.tecnico_id,
    estado: row.estado,
  }
}

function mapReglaConTecnico(regla: ReglaRow, tecnico: TecnicoRow): ReglaConTecnico {
  return { ...mapRegla(regla), tecnico: mapTecnico(tecnico) }
}

function mapRegla(row: ReglaRow): ReglaAsignacion {
  return {
    id: row.id,
    tecnico_id: row.tecnico_id,
    ciudad: row.ciudad,
    barrio: row.barrio ?? undefined,
    tipo_servicio: row.tipo_servicio ?? undefined,
    prioridad: row.prioridad,
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/** Devuelve todos los técnicos ordenados por nombre. */
export async function getTecnicos(): Promise<Tecnico[]> {
  const { data, error } = await supabase
    .from('tecnicos')
    .select('*')
    .order('nombre', { ascending: true })

  if (error) throw new Error(`Error al obtener técnicos: ${error.message}`)
  return (data ?? []).map(mapTecnico)
}

/** Datos para crear un nuevo técnico. */
export interface NuevoTecnicoInput {
  nombre: string
  telefono?: string
  documento?: string
}

/** Crea un técnico nuevo (activo) y devuelve el registro persistido. */
export async function crearTecnico(input: NuevoTecnicoInput): Promise<Tecnico> {
  const fila: Database['public']['Tables']['tecnicos']['Insert'] = {
    nombre: input.nombre.trim(),
    activo: true,
  }
  const telefono = input.telefono?.trim()
  const documento = input.documento?.trim()
  if (telefono) fila.telefono = telefono
  if (documento) fila.documento = documento

  const { data, error } = await supabase.from('tecnicos').insert(fila).select('*').single()

  if (error) throw new Error(`Error al crear el técnico: ${error.message}`)
  if (!data) throw new Error('No se recibió confirmación al crear el técnico.')
  return mapTecnico(data)
}

/** Devuelve las reglas de asignación con su técnico relacionado. */
export async function getReglas(): Promise<ReglaConTecnico[]> {
  const [reglasResult, tecnicosResult] = await Promise.all([
    leerTodasLasFilas<ReglaRow>((desde, hasta) =>
      supabase.from('reglas_asignacion').select('*').order('id').range(desde, hasta),
    ),
    leerTodasLasFilas<TecnicoRow>((desde, hasta) =>
      supabase.from('tecnicos').select('*').order('id').range(desde, hasta),
    ),
  ])

  if (reglasResult.error) {
    throw new Error(`Error al obtener reglas: ${reglasResult.error.message}`)
  }
  if (tecnicosResult.error) {
    throw new Error(`Error al obtener técnicos: ${tecnicosResult.error.message}`)
  }

  const tecnicosPorId = new Map(tecnicosResult.data.map((t) => [t.id, t]))

  return reglasResult.data.flatMap((regla) => {
    const tecnico = tecnicosPorId.get(regla.tecnico_id)
    if (!tecnico) return []
    return [mapReglaConTecnico(regla, tecnico)]
  })
}

/** Devuelve los servicios activos del despacho (conjunto de trabajo actual). */
export async function getServiciosActivos(): Promise<Servicio[]> {
  const { data: lote, error: loteError } = await supabase
    .from('lotes_carga')
    .select('id')
    .eq('es_linea_base', true)
    .maybeSingle()

  if (loteError) throw new Error(`Error al obtener el despacho activo: ${loteError.message}`)
  if (!lote) return []

  const { data: servicios, error: serviciosError } = await leerTodasLasFilas<ServicioRow>(
    (desde, hasta) =>
      supabase
        .from('servicios')
        .select('*')
        .eq('lote_id', lote.id)
        .order('id')
        .range(desde, hasta),
  )

  if (serviciosError) {
    throw new Error(`Error al obtener los servicios: ${serviciosError.message}`)
  }

  // Lista blanca de jurisdicción: excluye órdenes de zonas ajenas.
  return servicios.map(mapServicio).filter((s) => esSucursalAutorizada(s.ciudad))
}

/**
 * Reemplaza el despacho activo: borra los lotes anteriores (cascade elimina sus
 * servicios) y guarda el nuevo conjunto como el despacho actual.
 */
export async function reemplazarServiciosActivos(
  nombre: string,
  servicios: ServicioNuevo[],
): Promise<void> {
  // 1. Borrar todos los lotes anteriores (cascade elimina sus servicios).
  const { error: delError } = await supabase
    .from('lotes_carga')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000')

  if (delError) throw new Error(`Error al limpiar el despacho anterior: ${delError.message}`)

  // 2. Crear el nuevo lote activo.
  const { data: lote, error: loteError } = await supabase
    .from('lotes_carga')
    .insert({
      nombre,
      fecha_corte: new Date().toISOString(),
      es_linea_base: true,
      total_servicios: servicios.length,
    })
    .select('id')
    .single()

  if (loteError) throw new Error(`Error al crear el despacho: ${loteError.message}`)

  // 3. Insertar servicios en chunks.
  for (const chunk of chunkArray(servicios, TAMANO_LOTE_INSERCION)) {
    const filas = chunk.map((servicio) => ({ ...servicio, lote_id: lote.id }))
    const { error } = await supabase.from('servicios').insert(filas)
    if (error) throw new Error(`Error al insertar servicios: ${error.message}`)
  }
}

/** Reasigna manualmente un técnico a un servicio (o lo deja sin asignar). */
export async function actualizarTecnicoServicio(
  servicioId: string,
  tecnicoId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('servicios')
    .update({ tecnico_id: tecnicoId })
    .eq('id', servicioId)

  if (error) throw new Error(`Error al actualizar el técnico del servicio: ${error.message}`)
}

/** Elimina una regla de asignación existente. */
export async function eliminarRegla(reglaId: string): Promise<void> {
  const { error } = await supabase.from('reglas_asignacion').delete().eq('id', reglaId)

  if (error) throw new Error(`Error al eliminar la regla: ${error.message}`)
}

// ---- Importación masiva de la matriz de asignación ----

const TECNICOS_INVALIDOS = new Set(['', 'n/a', 'na', '-'])

function esTecnicoValido(nombre: string): boolean {
  const normalizado = nombre.trim().toLowerCase()
  if (TECNICOS_INVALIDOS.has(normalizado)) return false
  // Excluye placeholders como "Tecnico por asignar", "sin asignar", "pendiente".
  if (normalizado.includes('asignar') || normalizado.includes('pendiente')) return false
  return true
}

/**
 * Garantiza que existan técnicos con los nombres dados (inserta los que falten).
 * Devuelve cuántos se crearon y un mapa nombre → id.
 */
async function asegurarTecnicos(
  nombres: string[],
): Promise<{ creados: number; porNombre: Map<string, string> }> {
  const porNombre = new Map<string, string>()

  const { data: existentes, error } = await supabase.from('tecnicos').select('id, nombre')
  if (error) throw new Error(`Error al consultar técnicos: ${error.message}`)

  for (const tecnico of existentes ?? []) {
    porNombre.set(tecnico.nombre, tecnico.id)
  }

  const faltantes = nombres.filter((nombre) => !porNombre.has(nombre))

  if (faltantes.length > 0) {
    const { data: insertados, error: insertError } = await supabase
      .from('tecnicos')
      .insert(faltantes.map((nombre) => ({ nombre, activo: true })))
      .select('id, nombre')

    if (insertError) throw new Error(`Error al insertar técnicos: ${insertError.message}`)

    for (const tecnico of insertados ?? []) {
      porNombre.set(tecnico.nombre, tecnico.id)
    }
  }

  return { creados: faltantes.length, porNombre }
}

/**
 * Importa masivamente la matriz de asignación desde filas ya parseadas.
 * Crea los técnicos que falten y las reglas correspondientes (en lotes de 500).
 */
export async function importarMatrizDesdeExcel(
  filas: FilaMatrizImport[],
): Promise<{ tecnicosCreados: number; reglasCreadas: number }> {
  // 1. Técnicos únicos válidos
  const nombresTecnicos = new Set<string>()
  for (const fila of filas) {
    const nombre = (fila.tecnico ?? '').trim()
    if (esTecnicoValido(nombre)) nombresTecnicos.add(nombre)
  }

  // 2. Asegurar técnicos existentes (inserta los faltantes)
  const { creados: tecnicosCreados, porNombre } = await asegurarTecnicos([...nombresTecnicos])

  // 3. Construir reglas
  const reglas: NuevaRegla[] = []
  for (const fila of filas) {
    const nombreTecnico = (fila.tecnico ?? '').trim()
    if (!esTecnicoValido(nombreTecnico)) continue

    // Regla geográfica: sin sucursal/ciudad se descarta la fila (no hay reglas huérfanas).
    const ciudad = (fila.sucursal ?? '').trim()
    if (!ciudad) continue

    const tecnicoId = porNombre.get(nombreTecnico)
    if (!tecnicoId) continue // no debería ocurrir tras asegurar

    // Barrio se guarda con su texto original (la normalización ocurre al cruzar).
    const barrio = (fila.barrio ?? '').trim() || undefined
    const tipoServicio = (fila.tipo_servicio ?? '').trim() || undefined
    const prioridad = calcularPrioridad(ciudad, barrio, tipoServicio)

    reglas.push({
      tecnico_id: tecnicoId,
      ciudad,
      barrio,
      tipo_servicio: tipoServicio,
      prioridad,
    })
  }

  // 4. Insertar reglas en lotes de 500 (ignora las que ya existen: idempotente).
  let reglasInsertadas = 0
  for (const chunk of chunkArray(reglas, TAMANO_LOTE_INSERCION)) {
    const { data, error } = await supabase
      .from('reglas_asignacion')
      .upsert(chunk, { ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(`Error al insertar reglas: ${error.message}`)
    reglasInsertadas += data?.length ?? 0
  }

  return { tecnicosCreados, reglasCreadas: reglasInsertadas }
}

/**
 * Re-aplica la matriz de asignación a los servicios activos del despacho y
 * actualiza Supabase. Asigna las órdenes que ahora tienen técnico y libera
 * (deja en null) las que perdieron su regla. Devuelve el desglose.
 */
export async function reasignarServiciosActivos(): Promise<{
  asignadas: number
  desasignadas: number
}> {
  // 1. Lote activo.
  const { data: lote, error: loteError } = await supabase
    .from('lotes_carga')
    .select('id')
    .eq('es_linea_base', true)
    .maybeSingle()

  if (loteError) throw new Error(`Error al obtener el despacho activo: ${loteError.message}`)
  if (!lote) return { asignadas: 0, desasignadas: 0 }

  // 2. Servicios crudos del lote activo (paginado).
  const { data: serviciosData, error: serviciosError } = await leerTodasLasFilas<ServicioRow>(
    (desde, hasta) =>
      supabase
        .from('servicios')
        .select('*')
        .eq('lote_id', lote.id)
        .order('id')
        .range(desde, hasta),
  )

  if (serviciosError) {
    throw new Error(`Error al obtener los servicios: ${serviciosError.message}`)
  }
  const servicios = serviciosData

  // 3. Reglas activas de la matriz (paginado).
  const { data: reglasData, error: reglasError } = await leerTodasLasFilas<ReglaRow>(
    (desde, hasta) =>
      supabase.from('reglas_asignacion').select('*').order('id').range(desde, hasta),
  )

  if (reglasError) throw new Error(`Error al obtener las reglas: ${reglasError.message}`)

  // 4. Cruce en memoria (el motor preserva el orden entrada → salida).
  const asignados = aplicarMatrizAsignacion(
    servicios.map(mapServicio),
    reglasData.map(mapRegla),
  )

  // 5. Recolectar las filas cuyo técnico cambió (asignación o liberación).
  const filasActualizar: ServicioRow[] = []
  let asignadas = 0
  let desasignadas = 0
  for (let i = 0; i < asignados.length; i++) {
    const tecnicoId = asignados[i].tecnico_id
    if (servicios[i].tecnico_id !== tecnicoId) {
      filasActualizar.push({ ...servicios[i], tecnico_id: tecnicoId })
      if (tecnicoId) asignadas++
      else desasignadas++
    }
  }

  // 6. Persistir en chunks de 200 (upsert sobre la PK `id`).
  for (const chunk of chunkArray(filasActualizar, TAMANO_LOTE_ACTUALIZACION)) {
    const { error } = await supabase.from('servicios').upsert(chunk, { onConflict: 'id' })
    if (error) throw new Error(`Error al reasignar servicios: ${error.message}`)
  }

  return { asignadas, desasignadas }
}

/** Devuelve las ciudades activas por técnico: `{ [tecnicoId]: string[] }`. */
export async function getCiudadesActivas(): Promise<Record<string, string[]>> {
  const { data, error } = await leerTodasLasFilas<{ tecnico_id: string; ciudad: string }>(
    (desde, hasta) =>
      supabase
        .from('tecnicos_ciudades')
        .select('tecnico_id, ciudad')
        .order('id')
        .range(desde, hasta),
  )

  // Si la tabla aún no existe (migración pendiente), no romper la carga inicial.
  if (error) {
    console.warn('[MillaOps Hub] No se pudo leer tecnicos_ciudades:', error.message)
    return {}
  }

  const mapa: Record<string, string[]> = {}
  for (const fila of data) {
    // Unifica variantes por mayúsculas/tildes a la forma canónica de la lista blanca.
    const canonica = ciudadCanonica(fila.ciudad)
    if (!canonica) continue
    const lista = (mapa[fila.tecnico_id] ??= [])
    if (!lista.includes(canonica)) lista.push(canonica)
  }
  return mapa
}

/** Reemplaza la lista de ciudades activas de un técnico. */
export async function guardarCiudadesActivasTecnico(
  tecnicoId: string,
  ciudades: string[],
): Promise<void> {
  const { error: delError } = await supabase
    .from('tecnicos_ciudades')
    .delete()
    .eq('tecnico_id', tecnicoId)

  if (delError) throw new Error(`Error al limpiar ciudades activas: ${delError.message}`)

  if (ciudades.length === 0) return

  const { error: insError } = await supabase.from('tecnicos_ciudades').insert(
    ciudades.map((ciudad) => ({ tecnico_id: tecnicoId, ciudad })),
  )
  if (insError) throw new Error(`Error al guardar ciudades activas: ${insError.message}`)
}

/**
 * Configura la cuadrilla de un técnico para una ciudad determinada con un
 * **reemplazo atómico limpio**: borra todas las reglas previas del técnico en
 * esa ciudad y vuelve a insertar el payload (sin duplicados internos).
 *
 * - Cuadrilla general (Carro): crea una regla `prioridad = 2`,
 *   `tipo_servicio = null` por cada barrio seleccionado y **traspasa** la
 *   cobertura general (quita la P2 de cualquier otro técnico en esos barrios).
 * - Cuadrilla flotante (Moto): crea una regla `prioridad = 1`,
 *   `tipo_servicio = nombreServicio` por cada combinación (barrio × servicio).
 *   **No toca** reglas de otros técnicos (la moto y el carro coexisten).
 *
 * Al final re-aplica la matriz al despacho activo y devuelve la cantidad de
 * reglas insertadas.
 */
export async function asignarCuadrilla(
  tecnicoId: string,
  ciudad: string,
  config: ConfigCuadrilla,
): Promise<number> {
  const ciudadLimpia = limpiarTexto(ciudad)
  const ciudadNombre = ciudad.trim()
  // Deduplicación estricta en memoria antes de tocar la base de datos.
  const barriosUnicos = Array.from(
    new Set(config.barrios.map((b) => b.trim()).filter((b) => b !== '')),
  )
  const serviciosUnicos = Array.from(
    new Set(config.servicios.map((s) => s.trim()).filter((s) => s !== '')),
  )

  // 1. Borrar de forma tolerante a mayúsculas/minúsculas todas las reglas
  //    previas de este técnico en esta ciudad.
  const { error: deleteError } = await supabase
    .from('reglas_asignacion')
    .delete()
    .eq('tecnico_id', tecnicoId)
    .ilike('ciudad', ciudadNombre)

  if (deleteError) {
    console.error('[asignarCuadrilla] Error borrando reglas previas:', deleteError)
    throw new Error(`No se pudieron limpiar las reglas anteriores: ${deleteError.message}`)
  }

  // 2. Traspaso (solo cuadrilla general): quitar la regla general (P2) de otros
  //    técnicos en los barrios seleccionados (1 barrio = 1 carro).
  if (config.modalidad === 'general' && barriosUnicos.length > 0) {
    const { data: reglasAjenas, error: readAjenoError } = await supabase
      .from('reglas_asignacion')
      .select('id, ciudad, barrio, tipo_servicio')
      .neq('tecnico_id', tecnicoId)

    if (readAjenoError) {
      throw new Error(`Error al leer reglas ajenas: ${readAjenoError.message}`)
    }

    const barriosLimpios = new Set(barriosUnicos.map(limpiarBarrio))
    const idsAjenos = (reglasAjenas ?? [])
      .filter(
        (r) =>
          !r.tipo_servicio &&
          limpiarTexto(r.ciudad) === ciudadLimpia &&
          barriosLimpios.has(limpiarBarrio(r.barrio)),
      )
      .map((r) => r.id)

    if (idsAjenos.length > 0) {
      const { error: delAjenoError } = await supabase
        .from('reglas_asignacion')
        .delete()
        .in('id', idsAjenos)
      if (delAjenoError) throw new Error(`Error al traspasar barrios: ${delAjenoError.message}`)
    }
  }

  // 3. Construir el payload sin duplicados internos (claves de control).
  const registros: Array<{
    tecnico_id: string
    ciudad: string
    barrio: string
    tipo_servicio: string | null
    prioridad: number
  }> = []
  const clavesVistas = new Set<string>()

  if (config.modalidad === 'flotante') {
    for (const barrio of barriosUnicos) {
      for (const servicio of serviciosUnicos) {
        const keyCheck = `${barrio.trim().toLowerCase()}|${servicio.trim().toLowerCase()}`
        if (clavesVistas.has(keyCheck)) continue
        clavesVistas.add(keyCheck)
        registros.push({
          tecnico_id: tecnicoId,
          ciudad: ciudadNombre,
          barrio: barrio.trim(),
          tipo_servicio: servicio.trim(),
          prioridad: 1,
        })
      }
    }
  } else {
    for (const barrio of barriosUnicos) {
      const keyCheck = `${barrio.trim().toLowerCase()}|`
      if (clavesVistas.has(keyCheck)) continue
      clavesVistas.add(keyCheck)
      registros.push({
        tecnico_id: tecnicoId,
        ciudad: ciudadNombre,
        barrio: barrio.trim(),
        tipo_servicio: null,
        prioridad: 2,
      })
    }
  }

  // 4. Inserción secuencial en chunks de 200 (las filas previas ya se borraron
  //    y el array no tiene duplicados internos, así que .insert() no colisiona).
  for (const chunk of chunkArray(registros, 200)) {
    const { error: insertError } = await supabase.from('reglas_asignacion').insert(chunk)
    if (insertError) {
      console.error('[asignarCuadrilla] Error insertando chunk:', insertError, chunk[0])
      throw new Error(`Error insertando reglas: ${insertError.message}`)
    }
  }

  // 5. Re-aplicar la matriz al despacho activo y devolver el total insertado.
  await reasignarServiciosActivos()
  return registros.length
}

/**
 * Persiste el resultado de una auditoría de cierres en la nube (histórico
 * multiusuario). `datos_resultado` es el objeto completo `ResultadoCierres`,
 * que Supabase serializa a JSONB.
 */
export async function guardarAuditoriaCierres(payload: AuditoriaCierresInsert): Promise<void> {
  const { error } = await supabase.from('auditorias_cierres').insert(payload)
  if (error) throw new Error(`No se pudo guardar la auditoría: ${error.message}`)
}

/**
 * Devuelve la última auditoría guardada (ordenada por `created_at`), o `null`
 * si no hay registros o la tabla aún no existe (migración pendiente).
 */
export async function getUltimaAuditoriaCierres(): Promise<AuditoriaCierresRow | null> {
  const { data, error } = await supabase
    .from('auditorias_cierres')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[MillaOps Hub] No se pudo leer auditorias_cierres:', error.message)
    return null
  }
  return data
}
