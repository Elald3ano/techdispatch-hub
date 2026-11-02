# MillaOps Hub — Dossier de Control Arquitectónico

> **Autor:** Daniel Córdoba — Asistente Técnico Distrital · GitHub: [@elald3ano](https://github.com/elald3ano)
>
> **Subtítulo oficial:** *Seguimiento de Servicios Última Milla*.
> Documento de referencia del estado **real** del software, generado por inspección directa del
> código y verificación de la base de datos en Supabase.
>
> **Fecha de control:** 1 de noviembre de 2026 · **Cierre formal de Fase 2**
> **Stack:** React 19.3 · TypeScript ~6.0 · Vite 8.3 · Tailwind CSS v4.3 · Supabase JS 2.118

Este dossier es la fuente de verdad para cualquier capa de negocio nueva. Toda lógica adicional
debe respetar las **3 invariantes** descritas al final (sección 4).

---

## 1. Modelo de Datos y Estado en Supabase

### 1.1 Tablas vivas y esquemas

El esquema se define en `supabase/schema.sql` (script idempotente) y se amplía con migraciones
incrementales en `supabase/migration_*.sql`.

#### `tecnicos` — Técnicos disponibles para asignación

| Columna      | Tipo        | Restricciones                          |
|--------------|-------------|----------------------------------------|
| `id`         | UUID        | PK, `gen_random_uuid()`                 |
| `nombre`     | TEXT        | NOT NULL                                |
| `telefono`   | TEXT        | nullable                                |
| `documento`  | TEXT        | nullable                                |
| `activo`     | BOOLEAN     | NOT NULL DEFAULT `TRUE`                 |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()`                |

- Índice único `idx_tecnicos_nombre ON tecnicos (nombre)` (creado por el seed, garantiza que
  `asegurarTecnicos` no duplique técnicos por nombre).

#### `reglas_asignacion` — Matriz de asignación (ciudad/barrio/servicio → técnico)

| Columna         | Tipo        | Restricciones                                        |
|-----------------|-------------|------------------------------------------------------|
| `id`            | UUID        | PK, `gen_random_uuid()`                              |
| `tecnico_id`    | UUID        | FK → `tecnicos(id)` **ON DELETE CASCADE**            |
| `ciudad`        | TEXT        | NOT NULL                                             |
| `barrio`        | TEXT        | nullable                                             |
| `tipo_servicio` | TEXT        | nullable                                             |
| `prioridad`     | INTEGER     | NOT NULL DEFAULT `1` (1=Ciudad+Barrio+Servicio · 2=Ciudad+Barrio · 3=Solo Ciudad [obsoleto]) |
| `created_at`    | TIMESTAMPTZ | NOT NULL DEFAULT `now()`                             |

Índices relevantes:

- `idx_reglas_busqueda ON reglas_asignacion (ciudad, barrio, tipo_servicio)` — búsqueda en matriz.
- `idx_reglas_unica ON reglas_asignacion (tecnico_id, ciudad, COALESCE(barrio,''), COALESCE(tipo_servicio,''))`
  — índice único de **idempotencia** del seed.
- `idx_regla_especialidad_unica ON reglas_asignacion (ciudad, barrio, COALESCE(tipo_servicio, ''))`
  — índice único que materializa la **coexistencia jerárquica**: una sola regla general
  (`tipo_servicio = NULL → ''`) por `(ciudad, barrio)` y una regla flotante por cada
  `(ciudad, barrio, tipo_servicio)`. ⚠️ **Migración pendiente**
  (`supabase/migration_flotantes.sql`); reemplaza el índice obsoleto `idx_regla_ciudad_barrio_unica`.

#### `lotes_carga` — Lotes/cortes de importación

| Columna          | Tipo        | Restricciones                        |
|------------------|-------------|--------------------------------------|
| `id`             | UUID        | PK, `gen_random_uuid()`              |
| `nombre`         | TEXT        | NOT NULL                             |
| `fecha_corte`    | TIMESTAMPTZ | NOT NULL                             |
| `es_linea_base`  | BOOLEAN     | NOT NULL DEFAULT `FALSE`             |
| `total_servicios`| INTEGER     | NOT NULL DEFAULT `0`                 |
| `created_at`     | TIMESTAMPTZ | NOT NULL DEFAULT `now()`             |

- Índice único parcial `idx_unico_lote_linea_base ON lotes_carga (es_linea_base) WHERE es_linea_base = TRUE`
  — garantiza **un solo despacho activo** a la vez. `getServiciosActivos()` filtra `es_linea_base = TRUE`.

#### `servicios` — Órdenes importadas por lote

| Columna            | Tipo        | Restricciones                                        |
|--------------------|-------------|------------------------------------------------------|
| `id`               | UUID        | PK, `gen_random_uuid()`                              |
| `lote_id`          | UUID        | FK → `lotes_carga(id)` **ON DELETE CASCADE**         |
| `numero_orden`     | TEXT        | NOT NULL  (columna Sigma "Servicio")                 |
| `ciudad`           | TEXT        | NOT NULL  (columna Sigma "Sucursal")                 |
| `barrio`           | TEXT        | NOT NULL  (columna Sigma "Barrio")                   |
| `direccion`        | TEXT        | nullable  (columna Sigma "Dirección")                |
| `tipo_servicio`    | TEXT        | NOT NULL  (columna Sigma "Tipo de solicitud")        |
| `nombre_cliente`   | TEXT        | nullable  (columna Sigma "Nombre")                   |
| `telefono_cliente` | TEXT        | nullable  (columna Sigma "Teléfono")                 |
| `referencia_pago`  | TEXT        | nullable  (columna Sigma "Referencia de pago")       |
| `identificacion`   | TEXT        | nullable  (columna Sigma "Identificación")           |
| `estado_sigma`     | TEXT        | nullable  (columna Sigma "Estado en Sigma")          |
| `fecha_creacion`   | TIMESTAMPTZ | NOT NULL  (columna Sigma "Fecha de creación")        |
| `dias_antiguedad`  | INTEGER     | NOT NULL DEFAULT `0` (columna Sigma "Días abierta")  |
| `tecnico_id`       | UUID        | FK → `tecnicos(id)` **ON DELETE SET NULL**           |
| `estado`           | TEXT        | NOT NULL DEFAULT `'ABIERTO'` CHECK (`ABIERTO`/`CERRADO`) |
| `created_at`       | TIMESTAMPTZ | NOT NULL DEFAULT `now()`                             |

Índices: `idx_servicios_numero_orden` (diff), `idx_servicios_lote_estado` (filtrado),
`idx_servicios_tecnico_id` (asignación).

#### `tecnicos_ciudades` — Ciudades activas por técnico (Gestión Territorial)

`(tecnico_id, ciudad)` con `UNIQUE (tecnico_id, ciudad)` e índice por `tecnico_id`.
⚠️ **Migración pendiente** (`supabase/migration_tecnicos_ciudades.sql`). `getCiudadesActivas()`
la lee de forma defensiva: si la tabla no existe, devuelve `{}` y registra un `console.warn`.

#### `auditorias_cierres` — Histórico multiusuario de Auditoría de Cierres

| Columna                  | Tipo        | Restricciones                                        |
|--------------------------|-------------|------------------------------------------------------|
| `id`                     | UUID        | PK, `gen_random_uuid()`                              |
| `nombre_archivo_anterior`| TEXT        | NOT NULL                                             |
| `fecha_corte_anterior`   | TIMESTAMPTZ | NOT NULL                                             |
| `nombre_archivo_actual`  | TEXT        | NOT NULL                                             |
| `fecha_corte_actual`     | TIMESTAMPTZ | NOT NULL DEFAULT `now()`                             |
| `total_cerrados`         | INTEGER     | NOT NULL DEFAULT `0`                                 |
| `total_nuevos`           | INTEGER     | NOT NULL DEFAULT `0`                                 |
| `datos_resultado`        | JSONB       | NOT NULL  (objeto `ResultadoCierres` completo)       |
| `creado_por`             | TEXT        | DEFAULT `'Daniel Córdoba'`                           |
| `created_at`             | TIMESTAMPTZ | DEFAULT `now()`                                      |

- Índice `idx_auditorias_fecha ON auditorias_cierres (created_at DESC)` para la última en O(1).
- ⚠️ **Migración pendiente** (`supabase/migration_auditorias_cierres.sql`).
- `guardarAuditoriaCierres()` / `getUltimaAuditoriaCierres()` hidratan la UI tras F5 y entre
  usuarios (persistencia multiusuario).

#### Políticas RLS (Row Level Security)

Modelo **permisivo** (SPA estática en GitHub Pages): todas las tablas habilitan RLS con políticas
`FOR ALL TO anon, authenticated USING (TRUE) WITH CHECK (TRUE)`. Entorno operativo interno; sin
restricciones de fila por rol.

### 1.2 Estado de migraciones SQL (`supabase/`)

| Archivo                              | Estado        | Nota                                                        |
|--------------------------------------|---------------|-------------------------------------------------------------|
| `schema.sql`                         | base          | esquema + RLS + seed demo (idempotente)                     |
| `seed_matriz_completa.sql`           | base          | 30 técnicos + reglas (idempotente, `ON CONFLICT DO NOTHING`)|
| `migration_flotantes.sql`            | ⚠️ pendiente  | `idx_regla_especialidad_unica` (coexistencia P1/P2 a nivel DB) |
| `migration_tecnicos_ciudades.sql`    | ⚠️ pendiente  | tabla `tecnicos_ciudades`                                    |
| `migration_auditorias_cierres.sql`   | ⚠️ pendiente  | tabla `auditorias_cierres` (persistencia multiusuario)       |
| `migration_toro_foronda.sql`         | ⚠️ pendiente  | cobertura Foronda en "Toro Valle" + "La Union Valle"         |
| `migration_tecnico_documento.sql`    | redundante    | columna `documento` ya presente en `schema.sql`              |
| `migration_sigma_fields.sql`         | redundante    | columnas de cliente ya presentes en `schema.sql`             |
| `migration_regla_unica.sql`          | obsoleta      | índice `idx_regla_ciudad_barrio_unica` reemplazado por `migration_flotantes.sql` |

---

## 2. Motor de Ingesta y Reglas de Negocio Territoriales

### 2.1 Filtro de Jurisdicción — `src/lib/zonasPermitidas.ts`

Lista blanca operativa de **27 sucursales autorizadas** (`SUCURSALES_AUTORIZADAS`):

```
Zarzal, Yumbo, Villa Gorgona, Tulua, Toro Valle, Todos los Santos, Sonso,
Santander de Quilichao, Puerto Tejada, Presidente Valle, Palmira, Miranda,
Jamundi, Guacari, Florida, Chancos, Cerrito, Carmelo, Candelaria, Caloto,
Cali, La Union Valle, La Paila, Bugalagrande, Buga, BuenaVentura, Andalucia
```

1. `Set` precalculado con `limpiarTexto` (búsqueda O(1)).
2. `ALIASES` resuelve variantes de Sigma hacia su forma canónica (`Toro → Toro Valle`,
   `Presidente → Presidente Valle`, `Los Mangos* → Cali`, `La Unión/Unión* → La Union Valle`,
   `La Paila Valle → La Paila`).
3. `esSucursalAutorizada()` devuelve `true` solo si la ciudad normalizada está en el set o vía
   alias. Cualquier ciudad ajena (Pereira, Manizales, Medellín, Bogotá, etc.) se descarta.
4. `ciudadCanonica()` devuelve el nombre canónico exacto de la lista blanca (`''` si es ajena).

Se aplica en `parseServiciosExcel` (ingesta) y en `getServiciosActivos` (lectura).

### 2.2 Parser de Excel — `src/services/excelParser.ts`

`parseServiciosExcel(file, ciudadFiltro?)` lee un reporte Sigma y produce `ServicioNuevo[]`.
Pipeline: selección de hoja (prioriza la que contenga `"servicio"`) → mapeo de encabezados
(normalizados NFD) → descarte por jurisdicción → cálculo de antigüedad. Columnas requeridas:
`numero_orden`, `ciudad`, `barrio`, `tipo_servicio`, `fecha_creacion`.

### 2.3 Normalizador y Motor de Asignación

#### `limpiarTexto` — `src/lib/normalizer.ts` (fuente única de verdad)

```
lowercase → normalize('NFD') → quitar tildes [\u0300-\u036f] → [^a-z0-9] → trim
```

Determinista: conserva códigos de zona legítimos (`"C1" → "c1"`).

#### `limpiarPrefijoNodo` y `limpiarBarrio` — fusión de nodos comerciales

`limpiarPrefijoNodo(barrio)` elimina el prefijo de nodo comercial de Sigma (1–4 letras + guion
opcional + 1–3 dígitos + separador): `"JAMD-01 VILLA TATIANA" → "VILLA TATIANA"`,
`"BV06 - El Jardin" → "El Jardin"`. Un barrio sin prefijo queda intacto (`"12 DE OCTUBRE"`).

`limpiarBarrio(barrio) = limpiarTexto(limpiarPrefijoNodo(barrio))` **fusiona variantes de nodo
dentro de la misma ciudad**: `"JAMD-01 VILLA TATIANA"` y `"JAMD-02 Villa Tatiana"` producen la
clave `"villatatiana"`. No viola el namespace geográfico porque la **ciudad sigue siendo el prefijo
obligatorio** (`limpiarTexto(ciudad)|…`).

#### Motor de cascada — `src/services/assignmentEngine.ts`

`aplicarMatrizAsignacion(servicios, reglas)` resuelve en orden estricto (primera coincidencia gana):

| Prioridad | Clave de cruce | Resultado |
|-----------|----------------|-----------|
| **P1**    | `ciudad\|barrio\|servicio` | Técnico **Flotante** (Moto) |
| **P2**    | `ciudad\|barrio`           | Técnico **General / Carro** |
| *(fallback)* | —                       | `null` (**sin asignar**)   |

- El fallback **Prioridad 3 (solo ciudad)** fue eliminado: una orden sin dueño de barrio ni
  servicio específico queda **sin asignar**, nunca absorbida por una regla genérica.
- `calcularPrioridad()`: `1` (tres campos), `2` (ciudad+barrio), `3` (solo ciudad, ignorado).

#### Coexistencia Jerárquica (General + Flotante)

Un barrio convive entre **1 Técnico General (Carro)** (`prioridad = 2`, `tipo_servicio = NULL`) y
**N Técnicos Flotantes (Moto)** (una regla `prioridad = 1` por `tipo_servicio`). La cascada P1 → P2
garantiza que el flotante **intercepta** antes que el dueño territorial.

`asignarCuadrilla(tecnicoId, ciudad, config)` (`supabaseService.ts`):
borra reglas previas del técnico en la ciudad → traspasa la P2 de otros técnicos en los barrios
seleccionados (solo modalidad general) → inserta las reglas nuevas → re-aplica la matriz.

### 2.4 Lectura Paginada — `leerTodasLasFilas`

`leerTodasLasFilas<T>()` pagina con `.range()` + `.order('id')` y une todas las páginas. PostgREST
trunca a **1.000 filas** por defecto; la helper cubre `getReglas()`, `getServiciosActivos()`,
`reasignarServiciosActivos()` y `getCiudadesActivas()`. (`getTecnicos()` y `asegurarTecnicos()`
usan `select` simple: el universo de técnicos es ~33 registros, muy por debajo del límite.)

### 2.5 Semáforo SLA — `src/lib/sla.ts`

| Nivel | Condición | Color |
|-------|-----------|-------|
| 🟢 verde (al día) | `dias <= 1` | esmeralda sólido |
| 🟡 amarillo (atención) | `dias === 2` | amarillo + texto oscuro |
| 🔴 rojo (crítico) | `dias >= 3` | carmesí sólido |

`esCritica(d) = d >= 3` · `conRetraso(d) = d >= 2` (filtro de planilla PDF, `UMBRAL_RETRASO = 2`).
`clasificarSla()` + `SLA_BADGE_CLASSES` alimentan el bloque sólido de la tabla y el coloreado PDF.

---

## 3. Arquitectura Frontend (React 19 + Tailwind v4)

### 3.1 Árbol de componentes — `src/App.tsx`

`App` es el orquestador único con **tres pestañas** (`VistaPrincipal`):

1. **Centro de Mando** (`'centro_mando'`, **pantalla inicial por defecto**) → `AnaliticaDashboard`.
2. **Gestión Territorial** (`'territorio'`) → `DirectorioTecnicos` o `DetalleTecnicoTerritorio`.
3. **Auditoría de Cierres** (`'cierres'`) → `AuditoriaCierresDashboard`.

El antiguo **"Despacho en Vivo"** (`ServiceTable` + `MetricCards`) fue **retirado definitivamente**:
el Centro de Mando lo reemplaza como única vista operativa.

**Estados globales** (levantados en `App`):

| Estado              | Tipo                          | Origen |
|---------------------|-------------------------------|--------|
| `serviciosActivos`  | `Servicio[]`                  | `getServiciosActivos()` |
| `tecnicos`          | `Tecnico[]`                   | `getTecnicos()` |
| `reglas`            | `ReglaConTecnico[]`           | `getReglas()` |
| `ciudadesActivas`   | `Record<string, string[]>`    | `getCiudadesActivas()` |
| `resultadoCierres`  | `ResultadoCierres \| null`    | levantado para persistir entre pestañas |
| `tecnicoSeleccionadoId` | `string \| null`          | navegación del directorio territorial |

Flujos principales:

- **Ingesta** (`handleProcesar`): `parseServiciosExcel` (import diferido de `xlsx`) →
  `aplicarMatrizAsignacion` → `reemplazarServiciosActivos` → `cargarDatos`.
- **Sincronización** (`handleSincronizar`): `reasignarServiciosActivos()` re-aplica la matriz.
- **Auditoría de cierres**: `calcularCierres()` compara dos cortes; se persiste en
  `auditorias_cierres` y se hidrata con `getUltimaAuditoriaCierres()`.

Modal global: `PdfExportModal` ("Exportar PDF"). Toasts en `ToastContainer` vía `notificar`.

### 3.2 Centro de Mando — `src/components/analitica/AnaliticaDashboard.tsx`

Orquestador del módulo de analítica (sin consultar BD; trabaja sobre `serviciosActivos`):

- **Multi-select de sucursales** (`MultiSelectFilter`) con conteos canónicos.
- **"Cargar Reporte Sigma"**: modal con `FileUpload` que dispara `handleProcesar`.
- Layout **4/12 + 8/12**: `BalanceCuadrillas` (izquierda) + `RadiografiaTecnico` / `RadarMasivos`
  (derecha). Debajo, `RadarFlotantes` + `ControlCalidad` (2 columnas).

#### Selección Múltiple de Cuadrillas (despacho táctico conjunto)

Estado `tecnicosSeleccionadosIds: string[]` (puede incluir `'sin_asignar'` como pseudo-técnico):

- `toggleTecnico(id)` añade/remueve; `seleccionarTodosDeCiudad(ciudad)` /
  `deseleccionarTodosDeCiudad(ciudad)` actúan en masa; `limpiarSeleccionTecnicos()` vuelve a la
  vista global.
- `serviciosSeleccionados` = unión de las órdenes de todos los seleccionados (respeta el alcance
  de ciudad de "Sin Asignar").

`BalanceCuadrillas` (doble vista "Por Sucursal" / "Ranking Técnicos"): checkboxes accesibles por
fila, acción `☑️ Seleccionar todos en {ciudad}` / `Desmarcar`, barra flotante de selección activa
(`N técnicos seleccionados · ✕ Limpiar`), "Sin Asignar" fijado arriba y ordenamiento asc/desc.

`RadiografiaTecnico` (modo multicuadrilla): recibe `tecnicos: Tecnico[]`. Cabecera dinámica
(1 técnico → nombre; ≥2 → `👥 N Técnicos Seleccionados (ciudades)` + `Despacho táctico conjunto`).
Chips de servicio agregados (suman frecuencias de todos). Columna `TÉCNICO` visible en la tabla
cuando hay >1. Exporta planilla conjunta por grupos.

### 3.3 Radiografía y umbral dinámico — `RadiografiaTecnico.tsx`

- **Selector de umbral de días** (`UMBRALES_RAPIDOS`): `Todas` / `≥ 2 (Con retraso)` /
  `≥ 3 (Críticas)` / `≥ 5 (Muy críticas)` / `≥ 7 (Severas)`. Filtra la vista y el nombre del PDF
  (`PD-…-mas-Ndias-….pdf`).
- **Vista por barrios o lista**; ordenamiento por columna (días/orden/ciudad/barrio/cliente/servicio).
- **Clasificación liviano/pesado** vía `esServicioLiviano` (`tiposServicio.ts`).

### 3.4 Exportación dual (PDF + captura HD)

- **PDF 1-clic** — `generarPlanillaPdf(grupos, opciones)` (`pdfGenerator.ts`): planilla física por
  técnico (grupos de la selección, órdenes ya filtradas por chips + umbral). REGLA DE ORO: ordena
  por `dias_antiguedad` descendente. 7 columnas con `Firma Cliente` vacía. Carga **diferida** de
  `jspdf` + `jspdf-autotable` (chunks separados).
- **Captura HD para WhatsApp** — `html-to-image` (`imageExporter.ts`): `capturarElementoComoImagen`
  a escala 2x (fondo navy), `copiarImagenAlPortapapeles` (ClipboardItem PNG) con fallback a
  `descargarBlob`. Reemplaza a `html2canvas` (incompatible con OKLCH de Tailwind v4).

### 3.5 Módulo Territorial — `src/components/territorio/`

- `DirectorioTecnicos.tsx`: directorio maestro con búsqueda, pestañas de filtro e importación de
  matriz Excel (`importarMatrizDesdeExcel`).
- `DetalleTecnicoTerritorio.tsx`: configurador de cuadrillas por ciudad (modalidad General/Flotante,
  catálogo de 73 servicios, tablero de barrios con traspaso de P2).

### 3.6 Auditoría de Cierres — `src/components/cierres/`

`AuditoriaCierresDashboard` compara dos cortes (`calcularCierres`), muestra `RankingCierres`,
`RadiografiaCierres`, `BalanceNetoSucursales` y `AlertasRendimiento`, y persiste el resultado en
`auditorias_cierres` (`guardarAuditoriaCierres` / `getUltimaAuditoriaCierres`).

---

## 4. Invariantes del Sistema (no negociables)

1. **`limpiarTexto` es la única fuente de verdad de normalización.**
   Todo cruce geográfico usa `limpiarTexto`; el barrio usa `limpiarBarrio` (fusiona nodos sin tocar
   el prefijo de ciudad). Prohibido comparar cadenas crudas en claves de asignación.

2. **La lista blanca de jurisdicción (27 sucursales) se aplica SIEMPRE en la ingesta.**
   `esSucursalAutorizada` en `parseServiciosExcel` y `getServiciosActivos`. Ninguna zona ajena entra
   al despacho, a las métricas ni a los PDF.

3. **Coexistencia Jerárquica: 1 Barrio = 1 General (P2) + N Flotantes (P1).**
   El cruce evalúa **P1 → P2 → null**. Nunca reintroducir fallback por ciudad (P3) ni permitir más
   de un dueño general por `(ciudad, barrio)` (índice `idx_regla_especialidad_unica`).

---

### Mapa de archivos clave

```
src/
  App.tsx                              Orquestador: 3 pestañas, estados globales, flujos
  lib/
    normalizer.ts                      limpiarTexto / limpiarPrefijoNodo / limpiarBarrio (invariante #1)
    zonasPermitidas.ts                 lista blanca 27 + aliases (invariante #2)
    sla.ts                             semáforo SLA (≤1 verde · 2 amarillo · ≥3 rojo)
    tiposServicio.ts                   catálogo oficial de 73 tipos + clasificación liviano/pesado
    supabase.ts                        cliente Supabase + isSupabaseConfigured
    imageExporter.ts                   captura HD html-to-image + copiado/descarga PNG
    dateParser.ts                      fecha embebida del nombre Sigma + formato de rango
    utils.ts                           cn()
  services/
    excelParser.ts                     ingesta Sigma + matriz Excel (xlsx diferido)
    assignmentEngine.ts                cascada P1 (flotante) → P2 (general) + calcularPrioridad
    supabaseService.ts                 operaciones BD + asignarCuadrilla + leerTodasLasFilas + auditorías
    pdfGenerator.ts                    generarPlanillaPdf (jspdf diferido)
    reconciliationService.ts           calcularCierres (ResultadoCierres · BalanceCiudad.neto)
  components/
    MultiSelectFilter.tsx              combobox multi-selección con buscador
    PdfExportModal.tsx                 modal consolidado con filtro de ciudad
    analitica/
      AnaliticaDashboard.tsx           Centro de Mando (multi-select + drill-down)
      BalanceCuadrillas.tsx            doble vista + selección múltiple + "Sin Asignar"
      RadiografiaTecnico.tsx           radiografía mono/multicuadrilla + umbral + export
      RadarMasivos.tsx                 radar global (sin selección)
      RadarFlotantes.tsx               filtro de flota liviana/pesada
      ControlCalidad.tsx               órdenes críticas / balance de ciudades
      TarjetaAnalitica.tsx             primitivas de tarjeta + BarraProgreso
    territorio/
      DirectorioTecnicos.tsx           directorio + importador de matriz
      DetalleTecnicoTerritorio.tsx     configurador de cuadrillas
    cierres/
      AuditoriaCierresDashboard.tsx    comparación de cortes + persistencia
      RankingCierres.tsx / RadiografiaCierres.tsx / BalanceNetoSucursales.tsx / AlertasRendimiento.tsx
supabase/
  schema.sql                           esquema base + RLS + seed demo
  seed_matriz_completa.sql             30 técnicos + reglas (idempotente)
  migration_flotantes.sql              ⚠️ pendiente: idx_regla_especialidad_unica (P1/P2)
  migration_tecnicos_ciudades.sql      ⚠️ pendiente: tabla tecnicos_ciudades
  migration_auditorias_cierres.sql     ⚠️ pendiente: tabla auditorias_cierres
  migration_toro_foronda.sql           ⚠️ pendiente: cobertura Foronda (Toro Valle + La Union Valle)
```
