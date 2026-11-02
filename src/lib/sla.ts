/**
 * Clasificación de antigüedad / SLA compartida por métricas, bloques y filtros.
 * Una única fuente de verdad evita inconsistencias entre la tabla y las tarjetas.
 */
export type SlaLevel = 'ok' | 'warn' | 'critical'

/**
 * Semáforo de SLA (estilo Looker Studio):
 *  🟢 verde    → <= 1 día  (al día)
 *  🟡 amarillo → 2 días    (atención)
 *  🔴 rojo     → >= 3 días (crítico)
 */
export function clasificarSla(dias: number): SlaLevel {
  if (dias <= 1) return 'ok'
  if (dias === 2) return 'warn'
  return 'critical'
}

/** Órdenes "críticas": 3 o más días (alimenta bloque, KPI y filtro de PDF). */
export function esCritica(dias: number): boolean {
  return dias >= 3
}

/**
 * Órdenes "con retraso": 2 o más días (amarillas de 2 días + rojas de 3+).
 * Alimenta el filtro opcional de la planilla PDF.
 */
export function conRetraso(dias: number): boolean {
  return dias >= 2
}

/** Clases de Tailwind del bloque sólido por nivel de SLA (semáforo). */
export const SLA_BADGE_CLASSES: Record<SlaLevel, string> = {
  ok: 'bg-emerald-600 text-white',
  warn: 'bg-yellow-400 text-slate-900',
  critical: 'bg-red-600 text-white',
}

/** Ciudades sugeridas para el filtro de carga (solo sucursales de la lista blanca). */
export const CIUDADES_SUGERIDAS = [
  'Cali',
  'BuenaVentura',
  'Palmira',
  'Tulua',
  'Jamundi',
  'Buga',
] as const
