"use strict";

const BLOCK_TYPES = new Set([
  "statement_block",
  "block",
  "block_statement",
  "compound_statement",
  "suite",
  "class_body",
  "program",
  "module",
  "source_file",
  "translation_unit",
]);

const VARIABLE_DECLARATION_TYPES = new Set([
  "lexical_declaration",
  "variable_declaration",
  "local_variable_declaration",
  "short_var_declaration",
  "let_declaration",
  "const_declaration",
  "var_declaration",
  "declaration",
  "const_item",
  "static_item",
  "assignment",
  "annotated_assignment",
]);

const ASSIGNMENT_TYPES = new Set([
  "assignment_expression",
  "augmented_assignment_expression",
  "assignment",
  "augmented_assignment",
  "lexical_declaration",
  "variable_declaration",
  "local_variable_declaration",
  "short_var_declaration",
  "assignment_statement",
  "let_declaration",
  "const_declaration",
  "var_declaration",
]);

const CALL_TYPES = new Set([
  "call_expression",
  "call",
  "method_invocation",
  "method_call_expression",
  "call_statement",
]);

const MEMBER_TYPES = new Set([
  "member_expression",
  "attribute",
  "selector_expression",
  "field_expression",
  "member_access_expression",
  "navigation_expression",
  "subscript_expression",
  "element_access_expression",
]);

const UNWRAP_TYPES = new Set([
  "expression_statement",
  "export_statement",
  "await_expression",
  "parenthesized_expression",
  "labeled_statement",
  "return_statement",
  "yield_expression",
  "throw_statement",
]);

function field(node, name) {
  if (!node || typeof node.childForFieldName !== "function") return null;
  return node.childForFieldName(name);
}

function firstNamedOfType(node, type) {
  if (!node) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === type) return child;
  }
  return null;
}

function unwrap(node) {
  let current = node;
  const seen = new Set();
  while (current && UNWRAP_TYPES.has(current.type) && !seen.has(current)) {
    seen.add(current);
    const next =
      field(current, "declaration") ||
      field(current, "value") ||
      field(current, "body") ||
      field(current, "result") ||
      current.namedChild(0);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function assignmentTarget(node) {
  const left = field(node, "left");
  if (left) {
    if (left.type === "expression_list") return left.namedChild(0) || left;
    return left;
  }
  const declarator = field(node, "declarator") || firstNamedOfType(node, "variable_declarator");
  if (declarator) {
    return field(declarator, "name") || declarator.namedChild(0) || declarator;
  }
  return field(node, "name");
}

function callObject(node) {
  const direct = field(node, "object");
  if (direct) return direct;
  const callee = field(node, "function") || field(node, "method");
  if (!callee || !MEMBER_TYPES.has(callee.type)) return null;
  return (
    field(callee, "object") ||
    field(callee, "operand") ||
    field(callee, "value") ||
    callee.namedChild(0)
  );
}

function callMethod(node) {
  const named = field(node, "name");
  const callee = field(node, "function") || field(node, "method") || named;
  if (!callee) return null;
  if (MEMBER_TYPES.has(callee.type)) {
    return (
      field(callee, "property") ||
      field(callee, "attribute") ||
      field(callee, "field") ||
      callee.lastNamedChild
    );
  }
  return callee;
}

function isVariableDeclaration(statementNode) {
  const node = unwrap(statementNode);
  return Boolean(node && VARIABLE_DECLARATION_TYPES.has(node.type));
}

function significantSymbol(statementNode) {
  const node = unwrap(statementNode);
  if (!node) return null;
  if (ASSIGNMENT_TYPES.has(node.type)) {
    const lhs = assignmentTarget(node);
    if (!lhs) return null;
    return { kind: "assignment", name: lhs.text };
  }
  if (CALL_TYPES.has(node.type)) {
    const obj = callObject(node);
    if (obj) return { kind: "object-call", name: obj.text };
    const method = callMethod(node);
    if (method) return { kind: "method-call", name: method.text };
  }
  return null;
}

function enclosingCodeblock(node) {
  let current = node && node.parent;
  while (current && !BLOCK_TYPES.has(current.type)) current = current.parent;
  return current || null;
}

function walkToStatement(node) {
  let current = node;
  while (current && current.parent && !BLOCK_TYPES.has(current.parent.type)) {
    current = current.parent;
  }
  return current;
}

function namedStatements(root) {
  const out = [];
  if (!root) return out;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child.type === "comment" || child.type === "hash_bang_line" || child.type === "empty_statement") {
      continue;
    }
    out.push(child);
  }
  return out;
}

function nodeSpan(node) {
  if (!node) return null;
  return {
    type: node.type,
    text: node.text,
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

module.exports = {
  BLOCK_TYPES,
  significantSymbol,
  isVariableDeclaration,
  enclosingCodeblock,
  walkToStatement,
  namedStatements,
  nodeSpan,
  unwrap,
};
