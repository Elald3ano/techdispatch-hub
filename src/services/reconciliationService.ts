import { aplicarMatrizAsignacion } from './assignmentEngine'
import { ciudadCanonica, esSucursalAutorizada } from '../lib/zonasPermitidas'
import { limpiarTexto } from '../lib/normalizer'
import { esServicioLiviano } from '../lib/tiposServicio'
import type { ReglaConTecnico, Servicio } from '../types'

/** Métrica de cierre por técnico, basada en sus órdenes del corte anterior. */
export interface MetricaTecnicoCierre {
  tecnicoId: string
  nombre: string
  cerradas: number
  livianas: number
  pesadas: number
  ciudades: string[]
}

/** Balance neto de una sucursal: cerradas menos nuevas. */
export interface BalanceCiudad {
  ciudad: string
  cerradas: number
  nuevas: number
  neto: number
}

/** Resultado de la comparación entre dos cortes en el tiempo. */
export interface ResultadoCierres {
  cerrados: Servicio[]
  nuevos: Servicio[]
  metricasPorTecnico: MetricaTecnicoCierre[]
  balancePorCiudad: BalanceCiudad[]
}

/**
 * Motor de comparación en memoria (sin tocar la base de datos).
 *
 * Resta de conjuntos sobre `numero_orden`:
 *   · Cerrados = Ayer \ Hoy (ya no aparecen en el corte actual).
 *   · Nuevos   = Hoy \ Ayer (ingresaron entre cortes).
 *
 * Ambos conjuntos se filtran por la lista blanca de sucursales (Invariante #2)
 * y se les asigna técnico con la matriz actual para que sean comparables.
 */
export function calcularCierres(
  serviciosAyer: Servicio[],
  serviciosHoy: Servicio[],
  reglas: ReglaConTecnico[],
): ResultadoCierres {
  // 1. Lista blanca de jurisdicción (Invariante #2).
  const ayerFiltrados = serviciosAyer.filter((s) => esSucursalAutorizada(s.ciudad))
  const hoyFiltrados = serviciosHoy.filter((s) => esSucursalAutorizada(s.ciudad))

  // 2. Asignación de técnicos con la matriz actual.
  const ayerAsignados = aplicarMatrizAsignacion(ayerFiltrados, reglas)
  const hoyAsignados = aplicarMatrizAsignacion(hoyFiltrados, reglas)

  // 3. Claves de órdenes de Hoy para detectar cierres.
  const ordenesHoy = new Set(hoyAsignados.map((s) => s.numero_orden))

  // 4. Cerrados = Ayer \ Hoy.
  const cerrados = ayerAsignados.filter((s) => !ordenesHoy.has(s.numero_orden))

  // 5. Nuevos = Hoy \ Ayer.
  const ordenesAyer = new Set(ayerAsignados.map((s) => s.numero_orden))
  const nuevos = hoyAsignados.filter((s) => !ordenesAyer.has(s.numero_orden))

  // 6. Métricas por técnico (todos los técnicos con órdenes en Ayer).
  const nombrePorId = new Map<string, string>()
  for (const r of reglas) {
    if (!nombrePorId.has(r.tecnico_id)) nombrePorId.set(r.tecnico_id, r.tecnico.nombre)
  }

  const porTecnico = new Map<string, MetricaTecnicoCierre>()
  const ciudadesPorTecnico = new Map<string, Set<string>>()
  for (const s of ayerAsignados) {
    if (!s.tecnico_id) continue
    let m = porTecnico.get(s.tecnico_id)
    if (!m) {
      m = {
        tecnicoId: s.tecnico_id,
        nombre: nombrePorId.get(s.tecnico_id) ?? 'Técnico',
        cerradas: 0,
        livianas: 0,
        pesadas: 0,
        ciudades: [],
      }
      porTecnico.set(s.tecnico_id, m)
    }
    let set = ciudadesPorTecnico.get(s.tecnico_id)
    if (!set) {
      set = new Set()
      ciudadesPorTecnico.set(s.tecnico_id, set)
    }
    set.add(s.ciudad)
  }

  for (const s of cerrados) {
    if (!s.tecnico_id) continue
    const m = porTecnico.get(s.tecnico_id)
    if (!m) continue
    m.cerradas += 1
    if (esServicioLiviano(s.tipo_servicio)) m.livianas += 1
    else m.pesadas += 1
  }

  for (const [id, set] of ciudadesPorTecnico) {
    const m = porTecnico.get(id)
    if (m) m.ciudades = [...set].sort((a, b) => a.localeCompare(b))
  }

  const metricasPorTecnico = [...porTecnico.values()].sort((a, b) => b.cerradas - a.cerradas)

  // 7. Balance por ciudad (Invariante #1: limpiarTexto en la agrupación).
  const porCiudad = new Map<string, BalanceCiudad>()
  const acumular = (servicio: Servicio, campo: 'cerradas' | 'nuevas') => {
    const canonica = ciudadCanonica(servicio.ciudad) || servicio.ciudad
    const clave = limpiarTexto(canonica)
    let b = porCiudad.get(clave)
    if (!b) {
      b = { ciudad: canonica, cerradas: 0, nuevas: 0, neto: 0 }
      porCiudad.set(clave, b)
    }
    b[campo] += 1
  }

  for (const s of cerrados) acumular(s, 'cerradas')
  for (const s of nuevos) acumular(s, 'nuevas')

  for (const b of porCiudad.values()) {
    b.neto = b.cerradas - b.nuevas
  }
  const balancePorCiudad = [...porCiudad.values()].sort((a, b) => b.neto - a.neto)

  return { cerrados, nuevos, metricasPorTecnico, balancePorCiudad }
}
