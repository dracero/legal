package fiuba.legal.dictamen

import rego.v1

default requiere_colegiacion_pba := false
default requiere_consejo_nacional_caba := false
default aplica_ley_defensa_consumidor := false

# Funciones auxiliares de compatibilidad Rego v1
contains_any(text, terms) if {
	some t in terms
	contains(lower(text), lower(t))
}

matches_especialidad(especialidades, rama) if {
	rama in especialidades
}

matches_especialidad(especialidades, _) if {
	"Todas" in especialidades
}

first_or_default(arr, def) := arr[0] if {
	count(arr) > 0
} else := def

# Jurisdicción territorial
requiere_colegiacion_pba if {
	input.jurisdiccion == "PBA"
}

requiere_consejo_nacional_caba if {
	input.jurisdiccion in {"CABA", "Nacional"}
}

# 1. Infracciones de Ejercicio Profesional según las normas cargadas por el usuario
infracciones_ejercicio contains msg if {
	input.subcontratista_sin_matricula_verificada == true
	matching_nodes := [n.okf_id | some n in object.get(input, "nodos_cargados", []); contains_any(n.content, ["subcontrat", "matricul", "etica"])]
	fundamento_id := first_or_default(matching_nodes, "norma-cargada-responsabilidad")
	msg := {
		"codigo": "INF-SUBCONTRATISTA-CONTROL",
		"veredicto_determinista": "FALTA_DE_CONTROL_DE_MATRICULA_SUBCONTRATISTA",
		"fundamento_okf_id": fundamento_id,
		"directiva_redaccion": "Desarrollar la responsabilidad del ingeniero firmante por falta de verificación de la matrícula habilitante del subcontratista técnico (culpa in eligendo e in vigilando).",
	}
}

infracciones_ejercicio contains msg if {
	not input.matricula_jurisdiccion_activa
	matching_nodes := [n.okf_id | some n in object.get(input, "nodos_cargados", []); contains_any(n.content, ["matricul", "colegio", "consejo"])]
	fundamento_id := first_or_default(matching_nodes, "norma-cargada-matricula")
	msg := {
		"codigo": "INF-EJERCICIO-SIN-HABILITACION",
		"veredicto_determinista": "FALTA_DE_HABILITACION_O_MATRICULA_LOCAL",
		"fundamento_okf_id": fundamento_id,
		"directiva_redaccion": "Advertir que el ejercicio sin habilitación o matrícula activa en la jurisdicción de la obra invalida la eficacia administrativa del acto técnico y priva del cobro judicial de honorarios.",
	}
}

# 2. Cláusulas de dispensa o limitación de responsabilidad
clausulas_nulas contains msg if {
	input.hay_ruina_o_impropiedad_obra == true
	input.clausula_limitacion_o_dispensa == true
	matching_nodes := [n.okf_id | some n in object.get(input, "nodos_cargados", []); contains_any(n.content, ["dispensa", "orden publico", "ruina"])]
	fundamento_id := first_or_default(matching_nodes, "norma-cargada-orden-publico")
	msg := {
		"codigo": "NULIDAD-CLAUSULA-DISPENSA",
		"veredicto_determinista": "NULA_DE_NULIDAD_ABSOLUTA_POR_ORDEN_PUBLICO",
		"fundamento_okf_id": fundamento_id,
		"directiva_redaccion": "La seguridad técnica y edilicia es de orden público: toda cláusula contractual que limite o dispense la responsabilidad por ruina o vicios se tiene por no escrita.",
	}
}

# 3. Conflictos de incumbencias de título
conflictos_incumbencia contains msg if {
	input.rama_ingenieria == "Industrial"
	input.tarea_tecnica_critica == "alta_tension"
	matching_nodes := [n.okf_id | some n in object.get(input, "nodos_cargados", []); contains_any(n.content, ["incumbencia", "alcance", "reservad"])]
	fundamento_id := first_or_default(matching_nodes, "norma-cargada-incumbencias")
	msg := {
		"codigo": "INCUMBENCIA-EXCEDIDA-ALTA-TENSION",
		"veredicto_determinista": "EXCESO_DE_INCUMBENCIAS_RESERVADAS",
		"fundamento_okf_id": fundamento_id,
		"directiva_redaccion": "Establecer que las instalaciones de Alta Tensión constituyen una actividad profesional reservada que excede el título de Ingeniería Industrial, requiriendo firma de Ingeniero Electricista o Electromecánico.",
	}
}

# 4. Defensa del Consumidor
aplica_ley_defensa_consumidor if {
	input.modalidad_ejercicio == "empresa_constructora_comercial"
}

aplica_ley_defensa_consumidor if {
	input.existe_publicidad_enganosa == true
}

directivas_defensa_consumidor contains msg if {
	not aplica_ley_defensa_consumidor
	msg := {
		"codigo": "EXCLUSION-ESTATUTO-CONSUMIDOR",
		"veredicto_determinista": "INAPLICABILIDAD_DEFENSA_DEL_CONSUMIDOR",
		"fundamento_okf_id": "norma-cargada-ejercicio-liberal",
		"directiva_redaccion": "No aplicar el régimen general de defensa del consumidor al ejercicio liberal del profesional universitario matriculado; encuadrar bajo la responsabilidad contractual o extracontractual de las normas cargadas.",
	}
}

directivas_defensa_consumidor contains msg if {
	aplica_ley_defensa_consumidor
	msg := {
		"codigo": "APLICACION-ESTATUTO-CONSUMIDOR",
		"veredicto_determinista": "APLICACION_EXCEPCIONAL_ESTATUTO_CONSUMIDOR",
		"fundamento_okf_id": "norma-cargada-consumidor",
		"directiva_redaccion": "Aplica el estatuto del consumidor por verificarse actividad comercial de empresa constructora o publicidad vinculante.",
	}
}

# 5. Plazos de Garantía y Prescripción
evaluacion_plazos := res if {
	input.hay_ruina_o_impropiedad_obra == true
	anios := object.get(input, "anios_desde_recepcion", 3)
	anios <= 10
	res := {
		"en_plazo_garantia_decenal": true,
		"anios_transcurridos": anios,
		"plazo_maximo_caducidad_anios": 10,
		"plazo_prescripcion_anios": 1,
		"fundamento_okf_id": "norma-cargada-caducidad-decenal",
		"veredicto_determinista": "ACCION_DENTRO_DEL_PLAZO_DE_GARANTIA",
		"directiva_redaccion": sprintf("El hecho dañoso ocurrió a los %d años de la entrega, encontrándose dentro del plazo legal de garantía de 10 años para obras de larga duración.", [anios]),
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
		"fundamento_okf_id": "norma-cargada-caducidad-decenal",
		"veredicto_determinista": "CADUCIDAD_OPERADA_POR_EL_TRANSCURSO_DEL_TIEMPO",
		"directiva_redaccion": sprintf("Habiendo transcurrido %d años desde la entrega definitiva, la acción ha caducado por superar el plazo de 10 años.", [anios]),
	}
} else := {
	"en_plazo_garantia_decenal": true,
	"anios_transcurridos": object.get(input, "anios_desde_recepcion", 1),
	"plazo_maximo_caducidad_anios": 3,
	"plazo_prescripcion_anios": 1,
	"fundamento_okf_id": "norma-cargada-prescripcion-general",
	"veredicto_determinista": "PLAZO_ORDINARIO_DE_RESPONSABILIDAD",
	"directiva_redaccion": "Aplicar el régimen de prescripción general de las normas cargadas.",
}

# 6. Pirámide de Prelación Normativa de Kelsen
prelacion_kelsen := [
	{
		"rango": 1,
		"nivel": "Constitución Nacional y Tratados de Derechos Humanos (Arts. 31 y 121 CN)",
		"aplicacion": "Leyes de fondo dictadas por el Congreso Nacional prevalecen sobre regulaciones locales; el poder de policía profesional corresponde a las provincias y CABA.",
	},
	{
		"rango": 2,
		"nivel": "Leyes Nacionales y Provinciales Vigentes",
		"aplicacion": "Regulan las obligaciones civiles, penales, laborales y colegiación profesional.",
	},
	{
		"rango": 3,
		"nivel": "Decretos Reglamentarios, Resoluciones Ministeriales y Normas Técnicas",
		"aplicacion": "Especificaciones de seguridad, reglamentaciones técnicas y códigos de edificación locales subordinados a la ley.",
	},
]

# 7. Selección Dinámica de Nodos Obligatorios: Toma ÚNICAMENTE los nodos que el usuario cargó en Neo4j
nodos_okf_obligatorios contains n.okf_id if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	matches_especialidad(n.especialidades_fiuba, input.rama_ingenieria)
	n.jurisdiction in {"Nacional", input.jurisdiccion}
}

# 8. Términos de búsqueda adaptados
terminos_busqueda_obligatorios contains sprintf("%s %s %s", [input.rama_ingenieria, input.jurisdiccion, input.tarea_tecnica_critica])

# 9. Escenarios contrafácticos pedagógicos
escenarios_contrafacticos := [
	{
		"id": "CF-1-MODALIDAD",
		"titulo": "Variante A: Inversión de Modalidad Contractual (Liberal Autónomo vs. Dependencia)",
		"hipotesis": "Alterar la modalidad de prestación del servicio profesional analizado.",
		"regla_aplicable": "En relación de dependencia el empleador responde objetivamente como principal ante terceros, pero no exime la responsabilidad ética o penal personal del ingeniero si firma actos técnicos deficientes.",
	},
	{
		"id": "CF-2-EXIMICION",
		"titulo": "Variante B: Intento de Dispensa Contractual o Materiales Provistos por el Comitente",
		"hipotesis": "El comitente impone materiales defectuosos o cláusula de exoneración.",
		"regla_aplicable": "Las normas de seguridad pública y solidez constructiva son indisponibles: el profesional debe advertir el riesgo fehacientemente o renunciar a la encomienda técnica.",
	},
]
