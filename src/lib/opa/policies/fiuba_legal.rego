package fiuba.legal.dictamen

import rego.v1

default requiere_colegiacion_pba := false
default requiere_consejo_nacional_caba := false
default aplica_ley_defensa_consumidor := false

# 1. Jurisdicción y Matriculación (Decreto-Ley 6070/58 vs Ley 10.416 PBA)
requiere_colegiacion_pba if {
	input.jurisdiccion == "PBA"
}

requiere_consejo_nacional_caba if {
	input.jurisdiccion in {"CABA", "Nacional"}
}

# Regla: Infracción de Ejercicio Profesional por Jurisdicción o falta de control de matrícula de subcontratista
infracciones_ejercicio contains msg if {
	input.jurisdiccion == "CABA"
	not input.matricula_jurisdiccion_activa
	msg := {
		"codigo": "INF-MAT-CABA-6070",
		"veredicto_determinista": "EJERCICIO_ILEGAL_O_FALTA_ETICA_GRAVE",
		"fundamento_okf_id": "norma-dec-ley-6070-58",
		"directiva_redaccion": "Desarrollar las consecuencias administrativas del Decreto-Ley 6070/58 (multa, inhabilitación por Junta Central y Consejos CPIC/COPIME/CPII/CPIQ/COPITEC) y la imposibilidad jurídica de reclamar honorarios judicialmente por carecer de habilitación legal al momento de la labor.",
	}
}

infracciones_ejercicio contains msg if {
	input.jurisdiccion == "PBA"
	not input.matricula_jurisdiccion_activa
	msg := {
		"codigo": "INF-MAT-PBA-10416",
		"veredicto_determinista": "FALTA_MATRICULACION_Y_VISADO_CIPBA",
		"fundamento_okf_id": "norma-ley-10416-pba",
		"directiva_redaccion": "Explicar que la matrícula nacional (CABA) no habilita para ejercer en Provincia de Buenos Aires (Art. 121 CN). Según Ley 10.416 PBA y Ley 12.490 (CAAITBA), es obligatorio matricularse en el CIPBA y visar previamente el contrato profesional.",
	}
}

infracciones_ejercicio contains msg if {
	input.subcontratista_sin_matricula_verificada == true
	msg := {
		"codigo": "INF-SUBCONTRATISTA-CULPA-IN-ELIGENDO",
		"veredicto_determinista": "CULPA_IN_ELIGENDO_E_IN_VIGILANDO_Y_FALTA_ETICA",
		"fundamento_okf_id": "norma-ccycn-art-1274",
		"directiva_redaccion": "Desarrollar la responsabilidad concurrente del Art. 1274 inc. c) CCyCN y la falta al Código de Ética (Dec. 1099/84 Art. 2.2): el ingeniero firmante que subcontrata estudios de suelos, ensayos o cálculos sin verificar la matrícula habilitante del subcontratista incurre en culpa in eligendo, culpa in vigilando y facilitación de ejercicio ilegal.",
	}
}

# 2. Regla: Nulidad de cláusulas abusivas o de dispensa en locación de obra (Art. 1276 CCyCN)
clausulas_nulas contains msg if {
	input.hay_ruina_o_impropiedad_obra == true
	input.clausula_limitacion_o_dispensa == true
	msg := {
		"codigo": "NULIDAD-ORDEN-PUBLICO-ART-1276",
		"veredicto_determinista": "NULA_DE_NULIDAD_ABSOLUTA_POR_ORDEN_PUBLICO",
		"fundamento_okf_id": "norma-ccycn-art-1276",
		"directiva_redaccion": "Explicar extensamente el carácter de Orden Público del Art. 1276 CCyCN: la seguridad pública y edilicia prevalece sobre la autonomía de la voluntad (Arts. 12 y 958 CCyCN). Toda cláusula contractual o de pliego que dispense o limite la responsabilidad por ruina o vicio del suelo/materiales se tiene por no escrita.",
	}
}

# 3. Regla: Conflicto de Incumbencias y Actividades Reservadas al Título (Art. 43 LES / Res. ME 1232/01)
conflictos_incumbencia contains msg if {
	input.rama_ingenieria == "Industrial"
	input.tarea_tecnica_critica in {"alta_tension", "calculo_estructural_complejo_sismico", "estudio_geotecnico_fundaciones"}
	msg := {
		"codigo": "INCUMBENCIA-EXCEDIDA-INDUSTRIAL",
		"veredicto_determinista": "EXCESO_DE_INCUMBENCIAS_ACTIVIDAD_RESERVADA",
		"fundamento_okf_id": "norma-incumbencias-coneau-res-1232",
		"directiva_redaccion": "Establecer de modo tajante que el título de Ingeniero Industrial carece de incumbencia reservada para proyectos de Alta Tensión (reservado a Ing. Electricista/Electromecánico en COPIME/CIPBA) o cálculo estructural complejo y geotécnico de gran envergadura (reservado a Ing. Civil en CPIC/CIPBA) según Res. ME 1232/01 y Art. 43 Ley 24.521.",
	}
}

conflictos_incumbencia contains msg if {
	input.rama_ingenieria in {"Informatica", "Electronica"}
	input.tarea_tecnica_critica in {"calculo_estructural_complejo_sismico", "estudio_geotecnico_fundaciones", "aparatos_sometidos_a_presion"}
	msg := {
		"codigo": "INCUMBENCIA-EXCEDIDA-TIC",
		"veredicto_determinista": "INVASION_DE_INCUMBENCIA_CIVIL_O_MECANICA",
		"fundamento_okf_id": "norma-incumbencias-coneau-res-1232",
		"directiva_redaccion": "Señalar la incompetencia de título de Ingeniería en Informática/Electrónica para firmar cálculos estructurales, fundaciones o recipientes sometidos a presión, configurando usurpación de incumbencias reservadas y falta ética grave.",
	}
}

# 4. Regla: Exclusión de la Ley de Defensa del Consumidor 24.240 (Art. 2 LDC)
aplica_ley_defensa_consumidor if {
	input.modalidad_ejercicio == "empresa_constructora_comercial"
}

aplica_ley_defensa_consumidor if {
	input.existe_publicidad_enganosa == true
}

directivas_defensa_consumidor contains msg if {
	not aplica_ley_defensa_consumidor
	msg := {
		"codigo": "EXCLUSION-LDC-24240-ART2",
		"veredicto_determinista": "INAPLICABILIDAD_LEY_DEFENSA_DEL_CONSUMIDOR",
		"fundamento_okf_id": "norma-ley-24240-art-2",
		"directiva_redaccion": "PROHIBICIÓN DEÓNTICA: No aplicar la Ley 24.240 de Defensa del Consumidor al ejercicio liberal universitario del ingeniero matriculado (exclusión expresa del Art. 2 Ley 24.240). Encuadrar exclusivamente bajo locación de obra/servicios y responsabilidad profesional del CCyCN (Arts. 1251-1279 y 1768).",
	}
}

directivas_defensa_consumidor contains msg if {
	aplica_ley_defensa_consumidor
	msg := {
		"codigo": "EXCEPCION-LDC-24240-ACTIVA",
		"veredicto_determinista": "APLICACION_EXCEPCIONAL_LDC_24240",
		"fundamento_okf_id": "norma-ley-24240-art-2",
		"directiva_redaccion": "Explicar por qué en este caso opera la excepción del Art. 2 de la Ley 24.240 (actuación bajo forma de empresa constructora comercial o precisión publicitaria vinculante Art. 8 LDC).",
	}
}

# 5. Regla: Plazos de Caducidad y Prescripción en Ruina de Obra (Arts. 1273, 1275 y 2564 CCyCN)
evaluacion_plazos := res if {
	input.hay_ruina_o_impropiedad_obra == true
	anios := object.get(input, "anios_desde_recepcion", 3)
	anios <= 10
	res := {
		"en_plazo_garantia_decenal": true,
		"anios_transcurridos": anios,
		"plazo_maximo_caducidad_anios": 10,
		"plazo_prescripcion_anios": 1,
		"fundamento_okf_id": "norma-ccycn-art-1275",
		"veredicto_determinista": "ACCION_VIGENTE_DENTRO_DE_CADUCIDAD_DECENAL",
		"directiva_redaccion": sprintf("El siniestro ocurrió a los %d años de la recepción de la obra, encontrándose plenamente vigente el plazo de garantía y caducidad decenal (10 años) del Art. 1275 CCyCN. Advertir que el comitente dispone de 1 año de prescripción liberatoria desde la exteriorización de la ruina (Art. 2564 inc. c CCyCN).", [anios]),
	}
} else := res if {
	input.hay_ruina_o_impropiedad_obra == true
	anios := object.get(input, "anios_desde_recepcion", 12)
	anios > 10
	res := {
		"en_plazo_garantia_decenal": false,
		"anios_transcurridos": anios,
		"plazo_maximo_caducidad_anios": 10,
		"plazo_prescripcion_anios": 1,
		"fundamento_okf_id": "norma-ccycn-art-1275",
		"veredicto_determinista": "CADUCIDAD_DECENAL_OPERADA_DE_PLENO_DERECHO",
		"directiva_redaccion": sprintf("Habiendo transcurrido %d años desde la recepción definitiva, ha operado la caducidad sustancial de 10 años del Art. 1275 CCyCN.", [anios]),
	}
} else := {
	"en_plazo_garantia_decenal": true,
	"anios_transcurridos": object.get(input, "anios_desde_recepcion", 1),
	"plazo_maximo_caducidad_anios": 3,
	"plazo_prescripcion_anios": 1,
	"fundamento_okf_id": "norma-ccycn-art-1768",
	"veredicto_determinista": "REGIMEN_GENERAL_PRESCRIPCION_RESPONSABILIDAD_PROFESIONAL",
	"directiva_redaccion": "Analizar los plazos de prescripción general (3 años por responsabilidad civil Art. 2561 CCyCN y régimen de vicios ocultos Art. 1055 CCyCN).",
}

# 6. Regla: Prelación Normativa (Pirámide de Kelsen - Art. 31 y 75 inc. 12 CN)
prelacion_kelsen := [
	{
		"rango": 1,
		"nivel": "Constitución Nacional y Tratados DDHH (Art. 31, 75 inc. 12 y 121 CN)",
		"aplicacion": "Distribución de competencias: la legislación civil, comercial, penal y laboral corresponde al Congreso Nacional; el poder de policía sobre el ejercicio profesional y la edificación es local (CABA / Provincias).",
	},
	{
		"rango": 2,
		"nivel": "Leyes Nacionales de Fondo y Orden Público (CCyCN Ley 26.994, Código Penal, Ley 19.587 HyS, LCT 20.744, LRT 24.557)",
		"aplicacion": "Prevalecen sobre cualquier ordenanza municipal o reglamento local que pretenda reducir plazos de responsabilidad civil o dispensar vicios de suelo/materiales.",
	},
	{
		"rango": 3,
		"nivel": "Leyes de Colegiación y Decretos Reglamentarios (Dec.-Ley 6070/58, Ley 10.416 PBA, Dec. 1099/84, Dec. 351/79)",
		"aplicacion": "Regulan matriculación, ética profesional, visado previo y condiciones técnicas de higiene y seguridad.",
	},
	{
		"rango": 4,
		"nivel": "Resoluciones Ministeriales de Incumbencias (Res. ME 1232/01 y CONEAU) y Códigos de Edificación Locales",
		"aplicacion": "Delimitan actividades reservadas por título universitario y exigencias constructivas municipales, subordinadas a las leyes nacionales de fondo.",
	},
]

# 7. Nodos OKF Obligatorios según las variables fácticas extraídas
nodos_okf_obligatorios contains "norma-ccycn-art-1273" if {
	input.hay_ruina_o_impropiedad_obra == true
}

nodos_okf_obligatorios contains "norma-ccycn-art-1274" if {
	input.hay_ruina_o_impropiedad_obra == true
}

nodos_okf_obligatorios contains "norma-ccycn-art-1275" if {
	input.hay_ruina_o_impropiedad_obra == true
}

nodos_okf_obligatorios contains "norma-ccycn-art-1276" if {
	input.hay_ruina_o_impropiedad_obra == true
}

nodos_okf_obligatorios contains "norma-ley-10416-pba" if {
	input.jurisdiccion == "PBA"
}

nodos_okf_obligatorios contains "norma-dec-ley-6070-58" if {
	input.jurisdiccion in {"CABA", "Nacional"}
}

nodos_okf_obligatorios contains "norma-ley-19587-hys" if {
	input.involucra_higiene_y_seguridad == true
}

nodos_okf_obligatorios contains "norma-ley-24557-lrt" if {
	input.involucra_higiene_y_seguridad == true
}

nodos_okf_obligatorios contains "norma-lct-20744-dependencia" if {
	input.modalidad_ejercicio == "relacion_de_dependencia"
}

# Siempre obligatorios para cualquier dictamen de la cátedra FIUBA:
nodos_okf_obligatorios contains "norma-ccycn-art-1768"
nodos_okf_obligatorios contains "norma-codigo-etica-dec-1099-84"
nodos_okf_obligatorios contains "norma-incumbencias-coneau-res-1232"
nodos_okf_obligatorios contains "norma-codigo-penal-art-189"
nodos_okf_obligatorios contains "norma-ley-24240-art-2"

# 8. Términos de búsqueda obligatorios para recuperación híbrida (BM25 + Vector) en Neo4j
terminos_busqueda_obligatorios contains "ruina de obra vicio del suelo responsabilidad concurrente caducidad" if {
	input.hay_ruina_o_impropiedad_obra == true
}

terminos_busqueda_obligatorios contains "Colegio de Ingenieros Provincia de Buenos Aires Ley 10416 visado CAAITBA" if {
	input.jurisdiccion == "PBA"
}

terminos_busqueda_obligatorios contains "Decreto Ley 6070/58 Junta Central CPIC COPIME matrícula CABA" if {
	input.jurisdiccion in {"CABA", "Nacional"}
}

terminos_busqueda_obligatorios contains "Higiene y Seguridad Ley 19587 Decreto 351/79 Riesgos del Trabajo ART" if {
	input.involucra_higiene_y_seguridad == true
}

terminos_busqueda_obligatorios contains "Código de Ética Decreto 1099/84 incumbencias reservadas CONEAU responsabilidad penal estrago"

# 9. Generación de Escenarios Contrafácticos Deterministas para Sección IV
escenarios_contrafacticos := [
	{
		"id": "CF-1-MODALIDAD",
		"titulo": "Variante A: Inversión del Vínculo Contractual (Ejercicio Liberal Autónomo vs. Relación de Dependencia Ley 20.744)",
		"hipotesis": "Se invierte la modalidad de contratación del ingeniero actuante respecto del caso original.",
		"regla_aplicable": "Bajo relación de dependencia (Arts. 21 y 87 LCT 20.744 y Art. 1753 CCyCN), el empleador responde objetivamente ante terceros como principal, pero la subordinación jurídica y económica jamás comprende subordinación técnica: el ingeniero mantiene intacta su responsabilidad penal (Art. 189 CP) y ética (Dec. 1099/84) si firma planos o avala maniobras riesgosas por orden superior.",
	},
	{
		"id": "CF-2-CAUSALIDAD-VICIOS",
		"titulo": "Variante B: Permutación del Origen Técnico del Daño (Vicio del Suelo vs. Vicio de los Materiales Impuestos por el Comitente vs. Vicio de Proyecto)",
		"hipotesis": "El comitente provee directamente los materiales defectuosos o impone por escrito en el pliego un terreno inestable con cláusula de indemnidad a favor del ingeniero.",
		"regla_aplicable": "Por imperio de los Arts. 1273 y 1276 CCyCN (Orden Público), ni el vicio del suelo ni el vicio de los materiales provistos por el comitente constituyen 'causa ajena' eximente, y la cláusula de indemnidad se tiene por no escrita. El ingeniero tiene el deber ético y legal de rechazar materiales inaptos o renunciar a la dirección de obra (Art. 2.1.1 Dec. 1099/84).",
	},
	{
		"id": "CF-3-JURISDICCION-E-INCUMBENCIAS",
		"titulo": "Variante C: Desplazamiento Jurisdiccional (CABA Dec.-Ley 6070/58 vs. PBA Ley 10.416) y Conflicto de Incumbencias Reservadas",
		"hipotesis": "La obra se traslada de jurisdicción o es firmada por un ingeniero de otra especialidad de la FIUBA sin actividad reservada habilitante.",
		"regla_aplicable": "Se activa la incompetencia material por violación de las Resoluciones Ministeriales de Actividades Reservadas (Art. 43 Ley 24.521) y el ejercicio ilegal por carecer de matriculación local activa, acarreando nulidad del acto administrativo de habilitación, sanción disciplinaria de suspensión de matrícula y pérdida de acción judicial por cobro de honorarios.",
	},
]

