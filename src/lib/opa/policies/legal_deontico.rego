package legal.deontico

import rego.v1

# Funciones auxiliares de compatibilidad Rego v1
contains_term(text, term) if {
	contains(lower(text), lower(term))
}

contains_any(text, terms) if {
	some t in terms
	contains_term(text, t)
}

list_contains_term(arr, term) if {
	some item in arr
	contains_term(item, term)
}

list_contains_any(arr, terms) if {
	some item in arr
	some t in terms
	contains_term(item, t)
}

# Coincidencia disyuntiva para obligaciones
matches_obligation_context(omisiones, _, _, keywords) if {
	list_contains_any(omisiones, keywords)
}

matches_obligation_context(_, conductas, _, keywords) if {
	list_contains_any(conductas, keywords)
}

matches_obligation_context(_, _, resumen, keywords) if {
	contains_any(resumen, keywords)
}

matches_obligation_context(omisiones, _, _, _) if {
	count(omisiones) > 0
}

# Coincidencia disyuntiva para prohibiciones
matches_prohibition_context(conductas, _, keywords) if {
	list_contains_any(conductas, keywords)
}

matches_prohibition_context(_, resumen, keywords) if {
	contains_any(resumen, keywords)
}

matches_prohibition_context(conductas, _, _) if {
	count(conductas) > 0
}

# Coincidencia disyuntiva para cláusulas inválidas / nulidades
matches_nullity_context(clausulas, _, keywords) if {
	list_contains_any(clausulas, keywords)
}

matches_nullity_context(_, resumen, keywords) if {
	contains_any(resumen, keywords)
}

matches_nullity_context(clausulas, _, _) if {
	count(clausulas) > 0
}

# 1. Detección de Incumplimientos de Obligación (Mandatos Deónticos: Deberes de Hacer o Dar)
incumplimientos_obligacion contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad == "OBLIGACION"

	omisiones := object.get(input, "omisiones_atribuidas", [])
	conductas := object.get(input, "conductas_relevantes", [])
	resumen := object.get(input, "resumen_factico", "")
	keywords := object.get(r, "palabras_clave", [r.conducta, r.sujeto_normado])

	matches_obligation_context(omisiones, conductas, resumen, keywords)

	msg := {
		"codigo": sprintf("OBL-%s", [r.id]),
		"veredicto_determinista": "INCUMPLIMIENTO_DE_DEBER_NORMATIVO",
		"fundamento_okf_id": n.okf_id,
		"modalidad": "OBLIGACION",
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("Exigir el cumplimiento del deber '%s' asignado a '%s'. La inobservancia o reticencia configura infracción con consecuencia jurídica: %s.", [r.conducta, r.sujeto_normado, r.consecuencia]),
	}
}

# 2. Detección de Violaciones a Prohibiciones (Deberes de No Hacer / Conductas Vedadas)
violaciones_prohibicion contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad == "PROHIBICION"

	conductas := object.get(input, "conductas_relevantes", [])
	resumen := object.get(input, "resumen_factico", "")
	keywords := object.get(r, "palabras_clave", [r.conducta, r.sujeto_normado])

	matches_prohibition_context(conductas, resumen, keywords)

	msg := {
		"codigo": sprintf("PROH-%s", [r.id]),
		"veredicto_determinista": "TRANSGRESION_DE_PROHIBICION_EXPRESA",
		"fundamento_okf_id": n.okf_id,
		"modalidad": "PROHIBICION",
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("Determinar la transgresión de la prohibición '%s' imputada a '%s'. Sanción / efecto aplicable: %s.", [r.conducta, r.sujeto_normado, r.consecuencia]),
	}
}

# 3. Detección de Cláusulas Inválidas o Nulidades de Pleno Derecho
clausulas_invalidas contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad in {"SANCION_NULIDAD", "PROHIBICION"}

	clausulas := object.get(input, "clausulas_o_defensas_invocadas", [])
	resumen := object.get(input, "resumen_factico", "")
	keywords := object.get(r, "palabras_clave", [r.conducta, "dispensa", "renuncia", "exclusión", "limitación"])

	matches_nullity_context(clausulas, resumen, keywords)

	msg := {
		"codigo": sprintf("NUL-%s", [r.id]),
		"veredicto_determinista": "INEFICACIA_O_NULIDAD_DE_PLENO_DERECHO",
		"fundamento_okf_id": n.okf_id,
		"modalidad": r.modalidad,
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("La estipulación o defensa invocada vulnera el precepto imperativo '%s'. Consecuencia determinista: %s.", [r.conducta, r.consecuencia]),
	}
}

# 4. Reconocimiento de Permisiones y Facultades Legales (Derechos Subjetivos)
permisiones_aplicables contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad == "PERMISION"

	msg := {
		"codigo": sprintf("PERM-%s", [r.id]),
		"veredicto_determinista": "FACULTAD_O_DERECHO_RECONOCIDO",
		"fundamento_okf_id": n.okf_id,
		"modalidad": "PERMISION",
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("Reconocer la facultad de '%s' para '%s' bajo el supuesto: %s.", [r.sujeto_normado, r.conducta, r.condicion]),
	}
}

# 5. Prelación Normativa Universal (Jerarquía de Kelsen)
prelacion_kelsen := [
	{
		"rango": 1,
		"nivel": "Constitución y Tratados Internacionales de Derechos Fundamentales",
		"aplicacion": "Supremacía constitucional y garantías de orden público que subordinan a toda norma infraconstitucional.",
	},
	{
		"rango": 2,
		"nivel": "Leyes y Normas Sustantivas de Fondo",
		"aplicacion": "Preceptos imperativos inderogables por voluntad de las partes que estructuran el régimen de responsabilidad y derechos subjetivos.",
	},
	{
		"rango": 3,
		"nivel": "Decretos Reglamentarios, Resoluciones y Disposiciones Administrativas",
		"aplicacion": "Criterios técnicos, procedimientos de contralor y regulación de aplicación específica dictadas en el marco de la ley.",
	},
	{
		"rango": 4,
		"nivel": "Actos Jurídicos, Contratos y Convenciones Particulares",
		"aplicacion": "Autonomía de la voluntad vinculante para las partes siempre que no contravenga normas imperativas o de orden público.",
	},
]

# 6. Selección Dinámica de Nodos Obligatorios: Toma ÚNICAMENTE los nodos que el usuario cargó en Neo4j
nodos_okf_obligatorios contains n.okf_id if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
}

# 7. Términos de búsqueda extraídos de los hechos del caso
terminos_busqueda_obligatorios contains sprintf("%s %s", [object.get(input, "parte_evaluada", "parte"), object.get(input, "rol_o_condicion_juridica", "rol")])

# 8. Escenarios Contrafácticos Generados Dinámicamente
escenarios_contrafacticos := [
	{
		"id": "CF-1-CUMPLIMIENTO-ESTRICTO",
		"titulo": "Hipótesis Contrafáctica A: Cumplimiento Tempéstivo de Deberes Normativos",
		"hipotesis": "Si la parte evaluada hubiera cumplido en tiempo y forma las obligaciones prescriptas en el documento cargado.",
		"regla_aplicable": "El cumplimiento estricto extingue el factor de atribución de responsabilidad y enerva las sanciones previstas en el texto legal.",
	},
	{
		"id": "CF-2-VALIDEZ-DISPOSICION",
		"titulo": "Hipótesis Contrafáctica B: Invalidez o Nulidad de Cláusulas Contradictorias",
		"hipotesis": "Si las partes hubieran pactado dispensas o limitaciones contrarias a las prescripciones imperativas del documento.",
		"regla_aplicable": "Las cláusulas que contradigan normas imperativas se tienen por no escritas sin invalidar el resto de la relación jurídica vinculante.",
	},
]
