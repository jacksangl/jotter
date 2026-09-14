"""Restricted math parser and solver. No eval, exec, sympify(string), or parse_expr."""
import ast
import json
import re
import sys
import sympy as s
from sympy.solvers.solveset import NonlinearError
from sympy.printing.latex import LatexPrinter


class Paren(s.Function):
    """Marks a user-written (...) group so previews keep it. Stripped by plain() before solving."""


class Bracket(Paren):
    """Marks a user-written [...] group."""


def plain(expr):
    return expr.replace(Paren, lambda arg: arg)

FUNCTIONS = {name: getattr(s, name) for name in ('sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'sqrt', 'Abs')}
FUNCTIONS.update({'ln': s.log, 'abs': s.Abs})
CONSTANTS = {'pi': s.pi, 'e': s.E, 'i': s.I}


class Parser:
    def __init__(self, metadata=None):
        self.symbols = {}
        self.denominators = []
        self.metadata = metadata or {}

    def parse(self, source):
        if not isinstance(source, str) or not source.strip() or len(source) > 3000:
            raise ValueError('Enter a mathematical expression of at most 3,000 characters.')
        source = source.replace('^', '**').replace('−', '-').strip()
        tree = ast.parse(source, mode='eval')
        if sum(1 for _ in ast.walk(tree)) > 300:
            raise ValueError('This expression is too large. Split it into smaller equations.')

        raw_bytes = source.encode()

        def visit(node, depth=0, bare=False):
            if depth > 40:
                raise ValueError('Too many nested expressions.')
            nxt = lambda x, bare=False: visit(x, depth + 1, bare)
            if isinstance(node, ast.List) and len(node.elts) == 1:
                return Bracket(nxt(node.elts[0], True), evaluate=False)  # Square brackets group one math expression.
            if not bare and raw_bytes[:node.col_offset].rstrip().endswith(b'(') and raw_bytes[node.end_col_offset:].lstrip().startswith(b')'):
                return Paren(visit(node, depth, True), evaluate=False)
            if isinstance(node, ast.Constant) and type(node.value) in (int, float):
                raw = ast.get_source_segment(source, node)
                if len(raw) > 100:
                    raise ValueError('Numeric literal is too long.')
                value = s.Rational(raw)
                if abs(value) > s.Integer(10)**100:
                    raise ValueError('Numeric magnitude is too large.')
                return value
            if isinstance(node, ast.Name):
                name = node.id
                if name in CONSTANTS:
                    return CONSTANTS[name]
                if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,39}', name) or name in FUNCTIONS:
                    raise ValueError('Use variable names starting with a letter; function names are reserved.')
                if name not in self.symbols:
                    domain = self.metadata.get(name, {}).get('domain', 'real')
                    assumptions = {'real': True} if domain == 'real' else {domain: True} if domain in ('positive', 'integer') else {}
                    self.symbols[name] = s.Symbol(name, **assumptions)
                return self.symbols[name]
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                value = nxt(node.operand)
                return value if isinstance(node.op, ast.UAdd) else s.Mul(-1, value, evaluate=False)
            if isinstance(node, ast.BinOp):
                a, b = nxt(node.left), nxt(node.right)
                if isinstance(node.op, ast.Add): return s.Add(a, b, evaluate=False)
                if isinstance(node.op, ast.Sub): return s.Add(a, s.Mul(-1, b, evaluate=False), evaluate=False)
                if isinstance(node.op, ast.Mult): return s.Mul(a, b, evaluate=False)
                if isinstance(node.op, ast.Div):
                    self.denominators.append(b)
                    return s.Mul(a, s.Pow(b, -1, evaluate=False), evaluate=False)
                if isinstance(node.op, ast.Pow):
                    b = nxt(node.right, True)  # Parentheses around an exponent are syntax, not a visible group.
                    if b.is_number and (abs(b) > 100 or b.is_real is not True):
                        raise ValueError('Numeric powers must be real and between -100 and 100.')
                    if b.is_negative:
                        self.denominators.append(a)
                    return s.Pow(a, b, evaluate=False)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS and not node.keywords:
                count = len(node.args)
                if count != 1 and not (node.func.id in ('log', 'ln') and count == 2):
                    raise ValueError('Check the number of function arguments.')
                return FUNCTIONS[node.func.id](*[nxt(x, True) for x in node.args], evaluate=False)
            raise ValueError('Use numbers, variables, parentheses or square brackets, + - * / ^ and supported functions. Multiplication needs *.')
        return visit(tree.body)

    def equation(self, source):
        if not isinstance(source, str) or source.count('=') != 1:
            raise ValueError('An equation must have exactly one equals sign.')
        lhs, rhs = source.split('=')
        return self.parse(lhs), self.parse(rhs)


def finite(value):
    return value.is_finite is True and not value.has(s.nan, s.zoo, s.oo, -s.oo)


def preview_expression(expr):
    """Hide neutral product factors without simplifying the solver's expression."""
    if not expr.args:
        return expr
    args = [preview_expression(arg) for arg in expr.args]
    if expr.is_Mul:
        args = [arg for arg in args if arg != 1]
        if not args:
            return s.S.One
        if len(args) == 1:
            return args[0]
    return expr.func(*args, evaluate=False)


class Printer(LatexPrinter):
    """Shows user groups with the delimiters they typed."""
    def _print_Paren(self, expr):
        return r'\left(%s\right)' % self._print(expr.args[0])

    def _print_Bracket(self, expr):
        return r'\left[%s\right]' % self._print(expr.args[0])


def handle(request):
    operation = request.get('operation')
    metadata = request.get('metadata', {})
    parser = Parser(metadata)
    formulas = request.get('equations', [])
    if not isinstance(formulas, list) or not 1 <= len(formulas) <= 8:
        raise ValueError('Select between one and eight equations.')
    pairs = [parser.equation(x) for x in formulas]
    if len(parser.symbols) > 40:
        raise ValueError('Use at most 40 variables.')
    symbol_names = {symbol: metadata.get(name, {}).get('tex') or s.latex(symbol) for name, symbol in parser.symbols.items()}
    latex = lambda expr: Printer({'symbol_names': symbol_names, 'order': 'none'}).doprint(expr)
    if operation == 'inspect':
        return {'latex': [latex(s.Eq(preview_expression(a), preview_expression(b), evaluate=False)) for a, b in pairs],
                'variables': [{'key': name, 'tex': latex(symbol)} for name, symbol in parser.symbols.items()]}
    if operation != 'solve':
        raise ValueError('Unknown operation.')
    pairs = [(plain(a), plain(b)) for a, b in pairs]
    parser.denominators = [plain(d) for d in parser.denominators]
    unknown_names = request.get('unknowns', [])
    if not unknown_names or len(set(unknown_names)) != len(unknown_names) or any(x not in parser.symbols for x in unknown_names):
        raise ValueError('Choose distinct unknowns that appear in the equations.')
    unknowns = [parser.symbols[x] for x in unknown_names]
    values = {}
    for name, symbol in parser.symbols.items():
        if name in unknown_names:
            continue
        raw = request.get('values', {}).get(name, '')
        try:
            value_parser = Parser()
            value = s.simplify(plain(value_parser.parse(raw)))
            if value_parser.symbols or not finite(value):
                raise ValueError()
            if symbol.is_real and value.is_real is not True:
                raise ValueError()
            if symbol.is_positive and value.is_positive is not True:
                raise ValueError()
            if symbol.is_integer and value.is_integer is not True:
                raise ValueError()
        except Exception:
            raise ValueError(f'Enter a finite value for `{name}` matching its domain. Fractions and scientific notation are supported.') from None
        values[symbol] = value
    for denominator in parser.denominators:
        if s.simplify(denominator.subs(values)) == 0:
            raise ValueError('These values cause division by zero in the original equation.')
    expressions = [s.simplify((a - b).subs(values)) for a, b in pairs]
    if any(expr.has(s.nan, s.zoo, s.oo, -s.oo) for expr in expressions):
        raise ValueError('These values make the equation undefined.')
    numeric = request.get('numeric', False)
    if numeric:
        guesses = []
        for name in unknown_names:
            gp = Parser()
            value = s.simplify(plain(gp.parse(request.get('guesses', {}).get(name, ''))))
            if gp.symbols or not finite(value):
                raise ValueError(f'Enter a finite starting guess for `{name}`.')
            guesses.append(value)
        try:
            answer = s.nsolve(expressions, unknowns, guesses, prec=30, maxsteps=100)
        except (ValueError, ZeroDivisionError):
            return {'status': 'unresolved', 'message': 'Numerical solving did not converge. Try different starting guesses; this does not prove no solution exists.'}
        candidates = [tuple(answer)]
    else:
        try:
            matrix, vector = s.linear_eq_to_matrix(expressions, unknowns)
            solution_set = s.linsolve((matrix, vector), unknowns)
        except NonlinearError:
            if len(unknowns) == 1 and len(expressions) == 1:
                domain = s.S.Complexes if metadata.get(unknown_names[0], {}).get('domain') == 'complex' else s.S.Reals
                solution_set = s.solveset(expressions[0], unknowns[0], domain=domain)
                if isinstance(solution_set, s.FiniteSet):
                    solution_set = s.FiniteSet(*[(v,) for v in solution_set])
            else:
                if any(expr.has(s.Abs) for expr in expressions):
                    # nonlinsolve can drop Abs constraints and report spurious free variables.
                    solutions = s.solve(expressions, unknowns, dict=True)
                    solution_set = s.FiniteSet(*(tuple(row.get(v, v) for v in unknowns) for row in solutions))
                else:
                    solution_set = s.nonlinsolve(expressions, unknowns)
        if solution_set is s.S.EmptySet:
            return {'status': 'no-solution', 'message': 'No solution for these equations and values.'}
        if not isinstance(solution_set, s.FiniteSet):
            return {'status': 'conditional', 'message': 'The solution is a set or requires conditions. A single value cannot be selected automatically.', 'setLatex': latex(solution_set)}
        candidates = list(solution_set)
    answers = []
    unresolved = False
    parametric = False
    for candidate in candidates:
        if len(candidate) != len(unknowns) or any(not isinstance(v, s.Expr) for v in candidate):
            unresolved = True
            continue
        substitutions = {**values, **dict(zip(unknowns, candidate))}
        if any(v.free_symbols for v in candidate):
            parametric = True
            continue
        valid = True
        for symbol, value in zip(unknowns, candidate):
            if not finite(value) or (symbol.is_real and value.is_real is False) or (symbol.is_positive and value.is_positive is False) or (symbol.is_integer and value.is_integer is False):
                valid = False
        if any(s.simplify(d.subs(substitutions)) == 0 for d in parser.denominators):
            valid = False
        residuals = []
        for lhs, rhs in pairs:
            a, b = lhs.subs(substitutions), rhs.subs(substitutions)
            residual = s.simplify(a - b)
            if residual == 0:
                residuals.append(0.0)
                continue
            try:
                error = float(abs(s.N(residual, 30)) / max(1, abs(s.N(a, 30)), abs(s.N(b, 30))))
                if not error < 1e-10:
                    valid = False
                residuals.append(error)
            except (TypeError, ValueError):
                unresolved = True
                valid = False
        if not valid:
            continue
        answers.append({'variables': [{'key': name, 'latex': latex(value), 'decimal': str(s.N(value, 12))} for name, value in zip(unknown_names, candidate)], 'residual': max(residuals, default=0)})
    if parametric:
        return {'status': 'underdetermined', 'message': 'The equations leave free variables. Add an independent constraint or supply more known values.'}
    if not answers:
        return {'status': 'unresolved' if unresolved or numeric else 'no-solution', 'message': 'No verified solution was found.' if unresolved or numeric else 'No solution satisfies the original equations and variable domains.'}
    return {'status': 'solved', 'answers': answers, 'numeric': bool(numeric), 'message': 'One numerical root found from your guesses; other roots may exist.' if numeric else ''}


def respond(raw):
    try:
        if len(raw) > 100000:
            raise ValueError('Request too large.')
        result = handle(json.loads(raw))
        return {'ok': True, 'data': result}
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, SyntaxError)) else 'This equation could not be solved symbolically. Try numerical mode or simplify the expression.'
        return {'ok': False, 'error': message[:500]}


if __name__ == '__main__':
    if '--server' in sys.argv:
        # Initialize symbolic machinery during app startup, before the first click.
        warm = s.Symbol('warm')
        s.simplify(warm + 2 - 3)
        s.linsolve([warm - 1], [warm])
        for line in sys.stdin:
            print(json.dumps(respond(line)), flush=True)
    else:
        print(json.dumps(respond(sys.stdin.read(100001))))
