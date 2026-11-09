package legal.deontico_test

import data.legal.deontico
import rego.v1

test_evaluacion_deontica_documento if {
	mock_input := {
		"sujetos_involucrados": ["Comprador", "Proveedor"],
		"parte_evaluada": "Proveedor",
		"rol_o_condicion_juridica": "Vendedor profesional",
		"conductas_relevantes": ["Entrega de producto defectuoso", "Negativa de reemplazo"],
		"omisiones_atribuidas": ["Falta de información veraz", "Falta de garantía"],
		"danos_o_resultados": ["Daño patrimonial"],
		"clausulas_o_defensas_invocadas": ["Cláusula de renuncia a reclamos"],
		"resumen_factico": "El proveedor entregó mercadería dañada y rechaza reparar invocando una cláusula de exención.",
		"nodos_cargados": [
			{
				"okf_id": "norma-doc-art-1",
				"title": "Obligación de Garantía Legal",
				"status": "Vigente",
				"content": "El proveedor está obligado a garantizar la idoneidad del bien...",
				"deontic_rules": [
					{
						"id": "REG-01",
						"modalidad": "OBLIGACION",
						"sujeto_normado": "Proveedor",
						"conducta": "Garantizar la idoneidad y buen funcionamiento",
						"condicion": "Adquisición a título oneroso",
						"consecuencia": "Obligación de reparación o sustitución inmediata",
						"palabras_clave": ["garantía", "reemplazo", "idoneidad", "defecto"],
					},
					{
						"id": "REG-02",
						"modalidad": "PROHIBICION",
						"sujeto_normado": "Proveedor",
						"conducta": "Insertar cláusulas de dispensa de responsabilidad",
						"condicion": "Contratos de consumo",
						"consecuencia": "Nulidad absoluta de la cláusula de renuncia",
						"palabras_clave": ["dispensa", "renuncia", "exención", "responsabilidad"],
					},
					{
						"id": "REG-03",
						"modalidad": "PERMISION",
						"sujeto_normado": "Comprador",
						"conducta": "Exigir la restitución del precio pagado",
						"condicion": "Falla insubsanable",
						"consecuencia": "Reintegro total más intereses",
						"palabras_clave": ["restitución", "precio", "reintegro"],
					},
				],
			},
		],
	}

	incumplimientos := deontico.incumplimientos_obligacion with input as mock_input
	count(incumplimientos) >= 1

	violaciones := deontico.violaciones_prohibicion with input as mock_input
	count(violaciones) >= 1

	nulas := deontico.clausulas_invalidas with input as mock_input
	count(nulas) >= 1

	permisiones := deontico.permisiones_aplicables with input as mock_input
	count(permisiones) >= 1

	obligatorios := deontico.nodos_okf_obligatorios with input as mock_input
	"norma-doc-art-1" in obligatorios
}

