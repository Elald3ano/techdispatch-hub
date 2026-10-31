import { limpiarBarrio, limpiarTexto } from '../lib/normalizer'
import type { ReglaAsignacion, ServicioNuevo } from '../types'

/** Clave geográfica Prioridad 2 (ciudad + barrio canónico). */
function claveCiudadBarrio(ciudad: string, barrio: string): string {
  return `${limpiarTexto(ciudad)}|${limpiarBarrio(barrio)}`
}

/**
 * Aplica la matriz de asignación mediante una cascada determinista y
 * transparente usando `limpiarTexto` (ciudad/servicio) y `limpiarBarrio`
 * (barrio, fusionando variantes de nodo comercial). El orden es estricto:
 *
 *   P1 (Interceptación Flotante): limpiarTexto(ciudad)|limpiarBarrio(barrio)|limpiarTexto(servicio)
 *       → asigna al Técnico Flotante de ese servicio específico.
 *   P2 (Dueño Territorial del Barrio): limpiarTexto(ciudad)|limpiarBarrio(barrio)
 *       → asigna al Técnico de Carro (regla general, sin tipo de servicio).
 *   Sin coincidencia → null (sin asignar).
 *
 * El fallback por ciudad (antigua Prioridad 3) se elimina: una cuadrilla
 * flotante no debe quedar absorbida por una regla genérica de ciudad, y un
 * barrio sin dueño territorial debe quedar explícitamente sin asignar.
 */
export function aplicarMatrizAsignacion(
  servicios: ServicioNuevo[],
  reglas: ReglaAsignacion[],
): ServicioNuevo[] {
  const mapPrio1 = new Map<string, string>()
  const mapPrio2 = new Map<string, string>()

  for (const regla of reglas) {
    const tecnicoId = regla.tecnico_id

    if (regla.prioridad === 1) {
      if (!regla.barrio || !regla.tipo_servicio) continue
      const clave = `${limpiarTexto(regla.ciudad)}|${limpiarBarrio(regla.barrio)}|${limpiarTexto(regla.tipo_servicio)}`
      if (!mapPrio1.has(clave)) mapPrio1.set(clave, tecnicoId)
    } else if (regla.prioridad === 2) {
      if (!regla.barrio) continue
      const clave = claveCiudadBarrio(regla.ciudad, regla.barrio)
      if (!mapPrio2.has(clave)) mapPrio2.set(clave, tecnicoId)
    }
    // prioridad 3 (solo ciudad) queda obsoleta: ya no se asigna por ciudad.
  }

  let asignados = 0
  const resultado = servicios.map((servicio) => {
    const tecnicoId =
      mapPrio1.get(
        `${limpiarTexto(servicio.ciudad)}|${limpiarBarrio(servicio.barrio)}|${limpiarTexto(servicio.tipo_servicio)}`,
      ) ??
      mapPrio2.get(claveCiudadBarrio(servicio.ciudad, servicio.barrio)) ??
      null

    if (tecnicoId) asignados++
    return { ...servicio, tecnico_id: tecnicoId }
  })

  console.log(
    `[Motor] Procesados: ${servicios.length} | Asignados: ${asignados} | Sin Asignar: ${servicios.length - asignados}`,
  )

  return resultado
}

/**
 * Determina la prioridad de una regla según los criterios completados:
 * 1 = Ciudad+Barrio+Servicio (Cuadrilla Flotante) · 2 = Ciudad+Barrio
 * (Cuadrilla General / Carro) · 3 = Solo Ciudad (obsoleto: el motor ya no
 * asigna por ciudad, se conserva por compatibilidad de esquema).
 */
export function calcularPrioridad(
  ciudad: string,
  barrio?: string,
  tipoServicio?: string,
): number {
  if (ciudad && barrio && tipoServicio) return 1
  if (ciudad && barrio) return 2
  return 3
}
