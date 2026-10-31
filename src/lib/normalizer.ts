/**
 * Única fuente de verdad para la normalización/limpieza de texto.
 *
 * `limpiarTexto` deja únicamente letras y números en minúscula, eliminando
 * tildes, espacios, guiones y cualquier otro símbolo. Dos cadenas que
 * representen lo mismo serán idénticas el 100% de las veces:
 *
 *   "C1 NUEVO AMANECER"   -> "c1nuevoamanecer"
 *   "C1 - NUEVO AMANECER" -> "c1nuevoamanecer"
 *   "C1 Nuevo Amanecer "  -> "c1nuevoamanecer"
 */
export function limpiarTexto(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[^a-z0-9]/g, '') // deja solo letras y números
    .trim()
}

// Expresión regular que detecta prefijos comerciales de nodo:
// 1 a 4 letras + guion opcional + 1 a 3 dígitos + guion o espacio.
// Ejemplos detectados: "JAMD-01 ", "JAMD-02 - ", "BV06 - ", "CCO02 ", "T10 ",
// "SDQ-2-", "A1-", "C1 ".
const PREFIJO_NODO_REGEX = /^[a-zA-Z]{1,4}-?\d{1,3}(?:\s*-\s*|\s+|-)(?=.+)/

/**
 * Elimina el prefijo del nodo comercial preservando el nombre limpio legible del barrio.
 * Ejemplo: "JAMD-01 VILLA TATIANA" → "VILLA TATIANA"
 * Ejemplo: "BV06 - El Jardin" → "El Jardin"
 * Ejemplo: "12 DE OCTUBRE" → "12 DE OCTUBRE" (no empieza con letras, se conserva)
 */
export function limpiarPrefijoNodo(barrio: string | null | undefined): string {
  if (!barrio) return ''
  return barrio.replace(PREFIJO_NODO_REGEX, '').trim() || barrio.trim()
}

/**
 * Normaliza el barrio para comparaciones en memoria: sin nodo comercial, sin tildes,
 * solo letras y números. Fusiona variantes de nodo dentro de la misma ciudad.
 * Ejemplo: "JAMD-01 VILLA TATIANA" → "villatatiana"
 * Ejemplo: "JAMD-02 Villa Tatiana" → "villatatiana"
 */
export function limpiarBarrio(barrio: string | null | undefined): string {
  return limpiarTexto(limpiarPrefijoNodo(barrio))
}
