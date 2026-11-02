import type { jsPDF } from 'jspdf'
import type { Cell, CellHook, UserOptions } from 'jspdf-autotable'
import { format } from 'date-fns'
import { conRetraso } from '../lib/sla'
import type { Servicio, Tecnico } from '../types'

/** Umbral de "retraso" en la planilla: órdenes con 2 o más días abiertas. */
export const UMBRAL_RETRASO = 2

/** Fotografía de fecha/hora usada en el nombre de archivo de los PDF (`2026-10-28-1023`). */
export function marcaDeTiempo(fecha: Date = new Date()): string {
  return format(fecha, 'yyyy-MM-dd-HHmm')
}

/**
 * Convierte un texto en un slug seguro para nombres de archivo:
 * minúsculas, sin tildes, sin símbolos y con guiones únicos.
 */
export function slugificar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[^a-z0-9]+/g, '-') // reemplaza espacios y símbolos por guiones
    .replace(/^-+|-+$/g, '') // quita guiones en los extremos
}

export interface PlanillaTecnico {
  tecnico: Tecnico
  servicios: Servicio[]
}

export interface OpcionesPdf {
  soloCriticas: boolean
  ciudad: string
  /**
   * Si es `true`, el PDF conserva el orden exacto en que llegaron las órdenes
   * (filtradas y ordenadas por la pantalla). Si es `false`/`undefined`, se
   * reordena por SLA descendente (regla de oro del modal masivo matutino).
   */
  respetarOrden?: boolean
  /** Línea de contexto opcional ("Filtros: ≥ 7 días | Ordenado por: barrio (asc)"). */
  notaFiltros?: string
}

/** Adaptador sobre el predicado compartido para trabajar con `Servicio`. */
export function esServicioConRetraso(servicio: Servicio): boolean {
  return conRetraso(servicio.dias_antiguedad)
}

// ---- Constantes de diseño (A4 en milímetros) ----
const MARGEN = 14 // sangría del encabezado institucional
const MARGEN_TABLA = 8 // márgenes laterales estrechos de la tabla (máximo ancho útil)
const Y_KPI = 40
const ALTO_KPI = 19
const Y_TABLA = 62
const ALTO_BANDA = 34

const COLOR_NAVY: [number, number, number] = [30, 41, 59] // #1e293b
const COLOR_ROW_ALT: [number, number, number] = [248, 250, 252] // #f8fafc
const COLOR_ROJO: [number, number, number] = [220, 38, 38] // #dc2626
const COLOR_SLATE: [number, number, number] = [100, 116, 139] // #64748b
const COLOR_BORDE: [number, number, number] = [226, 232, 240] // #e2e8f0
const COLOR_TEXTO_OSCURO: [number, number, number] = [15, 23, 42] // #0f172a (slate-900)
const COLOR_DETALLE: [number, number, number] = [51, 65, 85] // #334155 (slate-700)
const COLOR_VERDE: [number, number, number] = [22, 163, 74] // #16a34a (green-600)
const COLOR_AMARILLO: [number, number, number] = [250, 204, 21] // #facc15 (yellow-400)

// ---- Estilos compartidos de las tablas (planilla y vista táctica) ----
// Ancho útil: 210 mm (A4) − 8 mm × 2 = 194 mm; los anchos de columna suman 194 mm.
const ESTILOS_CUERPO: UserOptions['styles'] = {
  fontSize: 8.5,
  cellPadding: 3,
  overflow: 'linebreak',
  valign: 'middle',
  lineColor: COLOR_BORDE,
  lineWidth: 0.2,
}

const ESTILOS_HEAD: UserOptions['headStyles'] = {
  fillColor: COLOR_NAVY,
  textColor: [255, 255, 255],
  fontStyle: 'bold',
  fontSize: 9,
  valign: 'middle',
}

const ANCHOS_COLUMNAS: UserOptions['columnStyles'] = {
  0: { cellWidth: 13, halign: 'center', fontStyle: 'bold' },
  1: { cellWidth: 21, textColor: COLOR_TEXTO_OSCURO },
  2: { cellWidth: 24, fontStyle: 'bold' },
  3: { cellWidth: 46 },
  4: { cellWidth: 42 },
  5: { cellWidth: 28 },
  6: { cellWidth: 20, halign: 'center' },
}

const CABECERAS = [
  'Días',
  'Orden #',
  'Ciudad',
  'Barrio / Dirección',
  'Cliente / Teléfono / Ref. Pago',
  'Tipo de Servicio',
  'Firma Cliente',
]

/** Une partes no vacías con " / " para celdas compuestas del PDF. */
function unir(...partes: Array<string | undefined>): string {
  return partes.filter((p): p is string => Boolean(p)).join(' / ')
}

// ---- Formateo de fecha local (sin depender de date-fns en el chunk pesado) ----
function formatearFecha(fecha: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(fecha.getDate())}/${pad(fecha.getMonth() + 1)}/${fecha.getFullYear()} ${pad(
    fecha.getHours(),
  )}:${pad(fecha.getMinutes())}`
}

/** Dibuja el encabezado institucional + KPIs de una planilla. */
function dibujarEncabezado(doc: jsPDF, grupo: PlanillaTecnico, opciones: OpcionesPdf): void {
  const ancho = doc.internal.pageSize.getWidth()
  const { tecnico, servicios } = grupo
  const criticas = servicios.filter(esServicioConRetraso).length
  const fecha = formatearFecha(new Date())

  // Banda superior institucional
  doc.setFillColor(...COLOR_NAVY)
  doc.rect(0, 0, ancho, ALTO_BANDA, 'F')

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('PLANILLA TÉCNICA DE DESPACHO', MARGEN, 13)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(148, 163, 184)
  doc.text('MillaOps Hub', ancho - MARGEN, 13, { align: 'right' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text(`Técnico: ${tecnico.nombre}`, MARGEN, 21)
  doc.text(`Teléfono: ${tecnico.telefono ?? 'No registrado'}`, MARGEN, 27)

  // Ciudades reales del técnico en esta planilla (esquina superior derecha).
  const ciudadesUnicas = [...new Set(servicios.map((s) => s.ciudad))].sort((a, b) =>
    a.localeCompare(b),
  )
  doc.text(
    `Ciudad(es): ${ciudadesUnicas.join(', ') || opciones.ciudad || 'Todas'}`,
    ancho - MARGEN,
    21,
    { align: 'right' },
  )
  doc.text(`Generado: ${fecha}`, ancho - MARGEN, 27, { align: 'right' })

  // Línea táctica de filtros/orden (solo cuando la vista los declara).
  if (opciones.notaFiltros) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(7.5)
    doc.setTextColor(203, 213, 225)
    doc.text(opciones.notaFiltros, ancho - MARGEN, 31.5, { align: 'right' })
  }

  // KPIs en cabecera (números grandes con borde definido).
  const anchoUtil = ancho - 2 * MARGEN
  const boxW = (anchoUtil - 6) / 2

  doc.setFillColor(241, 245, 249)
  doc.setDrawColor(203, 213, 225)
  doc.roundedRect(MARGEN, Y_KPI, boxW, ALTO_KPI, 2, 2, 'FD')
  doc.setTextColor(...COLOR_NAVY)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.text('TOTAL ÓRDENES ASIGNADAS', MARGEN + 5, Y_KPI + 6)
  doc.setFontSize(18)
  doc.text(String(servicios.length), MARGEN + 5, Y_KPI + 16)

  doc.setFillColor(254, 242, 242)
  doc.setDrawColor(254, 202, 202)
  doc.roundedRect(MARGEN + boxW + 6, Y_KPI, boxW, ALTO_KPI, 2, 2, 'FD')
  doc.setTextColor(...COLOR_ROJO)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.text(`CON RETRASO (${UMBRAL_RETRASO}+ DÍAS)`, MARGEN + boxW + 11, Y_KPI + 6)
  doc.setFontSize(18)
  doc.text(String(criticas), MARGEN + boxW + 11, Y_KPI + 16)
}

/**
 * Dibuja la celda compuesta de "Cliente" con tipografía mixta: nombre en
 * negrita 8.5 pt y teléfono/referencia en 8 pt (gris con contraste).
 */
function dibujarCeldaCliente(doc: jsPDF, cell: Cell, lineas: string[]): void {
  const F_NOMBRE = 8.5
  const F_DETALLE = 8
  const FACTOR_LINEA = 1.15 // coincide con jspdf-autotable (PHYSICAL_LINE_HEIGHT)
  const aMm = (pt: number) => (pt * 25.4) / 72

  const altoNombre = aMm(F_NOMBRE) * FACTOR_LINEA
  const altoDetalle = aMm(F_DETALLE) * FACTOR_LINEA
  const altoTotal = altoNombre + altoDetalle * (lineas.length - 1)

  const padTop = cell.padding('top')
  const disponible = cell.height - padTop - cell.padding('bottom')
  const tope = cell.y + padTop + Math.max(0, (disponible - altoTotal) / 2)

  const x = cell.x + cell.padding('left')
  let base = tope + aMm(F_NOMBRE) * (2 - FACTOR_LINEA) // ajuste de línea base de autotable

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(F_NOMBRE)
  doc.setTextColor(...COLOR_NAVY)
  doc.text(lineas[0] ?? '', x, base)
  base += altoNombre

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(F_DETALLE)
  doc.setTextColor(...COLOR_DETALLE)
  for (let i = 1; i < lineas.length; i++) {
    doc.text(lineas[i] ?? '', x, base)
    base += altoDetalle
  }
}

/**
 * Hooks para renderizar la columna "Cliente" con tipografía mixta. Suprime el
 * texto por defecto en `willDrawCell` (sin alterar el alto de fila ya calculado)
 * y lo redibuja en `didDrawCell` con nombre en negrita y detalle en gris.
 */
function crearHooksCliente(): { willDrawCell: CellHook; didDrawCell: CellHook } {
  const lineasPorCelda = new WeakMap<Cell, string[]>()
  return {
    willDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 4) return
      lineasPorCelda.set(data.cell, data.cell.text.slice())
      data.cell.text = []
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 4) return
      const lineas = lineasPorCelda.get(data.cell)
      if (!lineas || lineas.length === 0) return
      dibujarCeldaCliente(data.doc as jsPDF, data.cell, lineas)
    },
  }
}

/** Colorea la celda de "Días" con un bloque sólido de semáforo (verde/amarillo/rojo). */
const colorearDiasSemaforo: CellHook = (data) => {
  if (data.section !== 'body' || data.column.index !== 0) return
  const dias = Number(data.cell.raw) || 0
  data.cell.styles.halign = 'center'
  data.cell.styles.valign = 'middle'
  data.cell.styles.fontStyle = 'bold'

  if (dias <= 1) {
    // Verde esmeralda sólido (al día)
    data.cell.styles.fillColor = COLOR_VERDE
    data.cell.styles.textColor = [255, 255, 255]
  } else if (dias === 2) {
    // Amarillo intenso sólido (atención) con texto oscuro para contraste
    data.cell.styles.fillColor = COLOR_AMARILLO
    data.cell.styles.textColor = COLOR_TEXTO_OSCURO
  } else {
    // Rojo carmesí sólido (críticos >= 3 días)
    data.cell.styles.fillColor = COLOR_ROJO
    data.cell.styles.textColor = [255, 255, 255]
  }
}

/** Dibuja la tabla de órdenes de una planilla. */
function dibujarTabla(
  doc: jsPDF,
  servicios: Servicio[],
  autoTable: (doc: jsPDF, opciones: UserOptions) => void,
): void {
  const hooksCliente = crearHooksCliente()

  autoTable(doc, {
    startY: Y_TABLA,
    head: [CABECERAS],
    body: servicios.map((s) => [
      String(s.dias_antiguedad),
      s.numero_orden,
      s.ciudad,
      unir(s.barrio, s.direccion),
      [
        s.nombre_cliente || 'SIN NOMBRE',
        `Tel: ${s.telefono_cliente || 'S/T'}`,
        `Ref: ${s.referencia_pago || 'S/R'}`,
      ].join('\n'),
      s.tipo_servicio,
      '', // espacio en blanco para la firma del cliente
    ]),
    margin: { left: MARGEN_TABLA, right: MARGEN_TABLA, bottom: 26 },
    rowPageBreak: 'avoid',
    styles: ESTILOS_CUERPO,
    headStyles: ESTILOS_HEAD,
    alternateRowStyles: { fillColor: COLOR_ROW_ALT },
    columnStyles: ANCHOS_COLUMNAS,
    willDrawCell: hooksCliente.willDrawCell,
    didDrawCell: hooksCliente.didDrawCell,
    didParseCell: colorearDiasSemaforo,
  })
}

/** Agrega numeración de páginas y espacios de firma al pie de todas las páginas. */
function agregarPiePagina(doc: jsPDF): void {
  const totalPaginas = doc.getNumberOfPages()
  const ancho = doc.internal.pageSize.getWidth()
  const alto = doc.internal.pageSize.getHeight()
  const mitad = ancho / 2

  for (let i = 1; i <= totalPaginas; i++) {
    doc.setPage(i)

    doc.setDrawColor(...COLOR_BORDE)
    doc.setLineWidth(0.2)
    doc.line(MARGEN, alto - 24, ancho - MARGEN, alto - 24)

    doc.setDrawColor(...COLOR_SLATE)
    doc.setLineWidth(0.3)
    doc.line(MARGEN, alto - 22, mitad - 12, alto - 22)
    doc.line(mitad + 12, alto - 22, ancho - MARGEN, alto - 22)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...COLOR_SLATE)
    doc.text('Firma Supervisor', MARGEN, alto - 17)
    doc.text('Firma Técnico', mitad + 12, alto - 17)

    doc.text(
      `MillaOps Hub · Daniel Córdoba (Asistente Técnico Distrital) · Página ${i} de ${totalPaginas}`,
      mitad,
      alto - 8,
      { align: 'center' },
    )
  }
}

/**
 * Genera el PDF de planilla de despacho.
 * `grupos` contiene uno o varios técnicos (1 = específico, N = consolidado);
 * se inserta un salto de página entre cada técnico.
 *
 * Las dependencias pesadas (`jspdf`, `jspdf-autotable`) se cargan de forma
 * dinámica: así no entran en el bundle inicial y solo se descargan cuando el
 * usuario realmente exporta. `jsPDF` es una clase (no se puede aislar) y debe
 * importarse de forma estática; `jspdf-autotable` es una función y se carga aquí.
 */
export async function generarPlanillaPdf(
  grupos: PlanillaTecnico[],
  opciones: OpcionesPdf,
): Promise<jsPDF> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])

  const doc = new jsPDF({ unit: 'mm', format: 'a4' })

  const gruposFiltrados = grupos
    .map((grupo) => {
      // REGLA DE ORO (modal masivo): lo más crítico primero. La vista táctica
      // envía `respetarOrden: true` para conservar el orden de pantalla.
      const ordenesFinales = (
        opciones.soloCriticas
          ? grupo.servicios.filter(esServicioConRetraso)
          : grupo.servicios
      ).slice()
      if (!opciones.respetarOrden) {
        ordenesFinales.sort((a, b) => b.dias_antiguedad - a.dias_antiguedad)
      }
      return { tecnico: grupo.tecnico, servicios: ordenesFinales }
    })
    .filter((grupo) => grupo.servicios.length > 0)

  if (gruposFiltrados.length === 0) {
    throw new Error('No hay órdenes para exportar con los filtros seleccionados.')
  }

  gruposFiltrados.forEach((grupo, index) => {
    if (index > 0) doc.addPage()
    dibujarEncabezado(doc, grupo, opciones)
    dibujarTabla(doc, grupo.servicios, autoTable)
  })

  agregarPiePagina(doc)

  // Nomenclatura inteligente: el archivo lleva el nombre del técnico cuando la
  // planilla es suya; si es consolidada, indica la ciudad o la escala regional.
  const timestamp = marcaDeTiempo()
  const nombreArchivo = nombrePlanillaPdf(gruposFiltrados, opciones.ciudad, timestamp)

  doc.setProperties({ title: nombreArchivo.replace(/\.pdf$/, '') })
  return doc
}

/**
 * Nombre de archivo de la planilla de despacho: `PD-<tecnico|consolidado>-<timestamp>.pdf`.
 * Se calcula sobre los grupos que realmente se exportan (tras el filtro de críticas),
 * por lo que un único técnico con órdenes siempre produce su nombre.
 */
export function nombrePlanillaPdf(
  grupos: PlanillaTecnico[],
  ciudad: string,
  timestamp: string = marcaDeTiempo(),
): string {
  if (grupos.length === 1) {
    return `PD-${slugificar(grupos[0].tecnico.nombre)}-${timestamp}.pdf`
  }
  if (ciudad === 'Consolidado Regional') {
    return `PD-consolidado-regional-${timestamp}.pdf`
  }
  return `PD-consolidado-${slugificar(ciudad)}-${timestamp}.pdf`
}
