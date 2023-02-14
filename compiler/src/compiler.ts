// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../jacdac-ts/jacdac-spec/spectool/jdspec.d.ts" />
/// <reference path="../../runtime/jacdac-c/dcfg/srvcfg.d.ts" />

import * as ts from "typescript"
import { SyntaxKind as SK } from "typescript"

import {
    SystemReg,
    SRV_DEVICE_SCRIPT_CONDITION,
} from "../../runtime/jacdac-c/jacdac/dist/specconstants"

import {
    stringToUint8Array,
    toHex,
    toUTF8,
    write16,
    write32,
    strcmp,
    encodeU32LE,
    fromHex,
    bufferEq,
    uniqueMap,
    encodeU16LE,
    range,
    arrayConcatMany,
} from "./jdutil"

import {
    BinFmt,
    Host,
    OpCall,
    NumFmt,
    Op,
    SMap,
    DevsDiagnostic,
    BUILTIN_STRING__VAL,
    StrIdx,
    BUILTIN_OBJECT__VAL,
    BuiltInString,
    BuiltInObject,
    NumFmtSpecial,
    PacketSpecCode,
    PacketSpecFlag,
    FieldSpecFlag,
    ServiceSpecFlag,
    FunctionFlag,
} from "./format"
import { addUnique, assert, camelize, oops, strlen, upperCamel } from "./util"
import {
    bufferFmt,
    DelayedCodeSection,
    literal,
    Label,
    nonEmittable,
    OpWriter,
    SectionWriter,
    TopOpWriter,
    Value,
    VariableKind,
    packVarIndex,
    CachedValue,
} from "./opwriter"
import { buildAST, formatDiagnostics, getProgramDiagnostics } from "./tsiface"
import { preludeFiles } from "./specgen"
import { jacdacDefaultSpecifications } from "./embedspecs"
import {
    VarDebugInfo,
    RoleDebugInfo,
    FunctionDebugInfo,
    DebugInfo,
    SrcLocation,
    DebugVarType,
    SrcFile,
    srcMapEntrySize,
} from "./info"
import { computeSizes } from "./debug"
import { BaseServiceConfig } from "@devicescript/srvcfg"
import { jsonToDcfg, serializeDcfg } from "./dcfg"

export const JD_SERIAL_HEADER_SIZE = 16
export const JD_SERIAL_MAX_PAYLOAD_SIZE = 236

export const CMD_GET_REG = 0x1000
export const CMD_SET_REG = 0x2000

export const DEVS_FILE_PREFIX = "bytecode"
export const DEVS_BYTECODE_FILE = `${DEVS_FILE_PREFIX}.devs`

export const DEVS_LIB_FILE = `${DEVS_FILE_PREFIX}-lib.json`
export const DEVS_BODY_FILE = `${DEVS_FILE_PREFIX}-body.json`
export const DEVS_DBG_FILE = `${DEVS_FILE_PREFIX}-dbg.json`
export const DEVS_SIZES_FILE = `${DEVS_FILE_PREFIX}-sizes.md`

const coreModule = "@devicescript/core"

const builtInObjByName: Record<string, BuiltInObject> = {
    "#ds.": BuiltInObject.DEVICESCRIPT,
    "#ArrayConstructor.prototype": BuiltInObject.ARRAY_PROTOTYPE,
    "#ds.RegisterNumber.prototype": BuiltInObject.DSREGISTER_PROTOTYPE,
}
BUILTIN_OBJECT__VAL.forEach((n, i) => {
    n = n.replace(/_prototype$/, ".prototype")
    if (n.indexOf("_") < 0 && i != BuiltInObject.DEVICESCRIPT)
        builtInObjByName["#" + n.replace(/^Ds/, "ds.")] = i
})

type TsFunctionDecl =
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ClassDeclaration

class Cell {
    _index: number

    constructor(
        public definition:
            | TsFunctionDecl
            | ts.VariableDeclaration
            | ts.ParameterDeclaration
            | ts.BindingElement
            | ts.Identifier,
        scope: Cell[],
        public _name?: string
    ) {
        this._index = scope.length
        scope.push(this)
    }
    emit(wr: OpWriter): Value {
        oops("on value() on generic Cell")
    }
    canStore() {
        return false
    }
    getName() {
        if (!this._name) {
            if (ts.isIdentifier(this.definition))
                this._name = idName(this.definition)
            else this._name = idName(this.definition.name)
        }
        return this._name
    }
}

class Role extends Cell {
    stringIndex: number
    used = false

    constructor(
        prog: Program,
        definition: ts.VariableDeclaration | ts.Identifier,
        scope: Role[],
        public spec: jdspec.ServiceSpec,
        _name?: string
    ) {
        super(definition, scope, _name)
        assert(!!spec, "no spec " + this._name)
        this.stringIndex = prog.addString(this.getName())
    }
    emit(wr: OpWriter): Value {
        const r = wr.emitExpr(Op.EXPRx_STATIC_ROLE, literal(this._index))
        this.used = true
        return r
    }
    serialize() {
        const r = new Uint8Array(BinFmt.ROLE_HEADER_SIZE)
        write32(r, 0, this.spec.classIdentifier)
        write16(r, 4, this.stringIndex)
        return r
    }
    toString() {
        return `role ${this.getName()}`
    }
    isSensor() {
        return this.spec.packets.some(
            p => p.identifier == SystemReg.StreamingSamples
        )
    }
    isCondition() {
        return this.spec.classIdentifier == SRV_DEVICE_SCRIPT_CONDITION
    }
    debugInfo(): RoleDebugInfo {
        return {
            name: this.getName(),
            serviceClass: this.spec.classIdentifier,
        }
    }
}

class Variable extends Cell {
    public parentProc: Procedure

    constructor(
        definition:
            | ts.VariableDeclaration
            | ts.ParameterDeclaration
            | ts.FunctionDeclaration
            | ts.BindingElement,
        public vkind: VariableKind,
        scopeOrProc: Variable[] | Procedure,
        name?: string
    ) {
        super(
            definition,
            scopeOrProc instanceof Procedure
                ? vkind == VariableKind.Local
                    ? scopeOrProc.locals
                    : scopeOrProc.params
                : scopeOrProc,
            name
        )
        if (scopeOrProc instanceof Procedure) this.parentProc = scopeOrProc
    }

    emitViaClosure(wr: OpWriter, lev: number) {
        if (lev == 0) return this.emit(wr)
        const r = wr.emitExpr(
            Op.EXPRx1_LOAD_CLOSURE,
            literal(this.getClosureIndex()),
            literal(lev)
        )
        return r
    }

    private get packedIndex() {
        return packVarIndex(this.vkind, this._index)
    }

    getClosureIndex() {
        assert(this.vkind != VariableKind.Global)
        return this.parentProc.mapVarOffset(this.packedIndex)
    }

    private assertDirect(wr: OpWriter) {
        if (this.parentProc) {
            assert((wr.prog as Program).proc == this.parentProc)
        }
    }

    emit(wr: OpWriter): Value {
        this.assertDirect(wr)
        let r: Value
        if (this.vkind == VariableKind.Global)
            r = wr.emitMemRef(Op.EXPRx_LOAD_GLOBAL, this.packedIndex)
        else r = wr.emitMemRef(Op.EXPRx_LOAD_LOCAL, this.packedIndex)
        return r
    }
    canStore() {
        return true
    }
    store(wr: OpWriter, src: Value, lev: number) {
        if (lev == 0) {
            this.assertDirect(wr)
            if (this.vkind == VariableKind.Global)
                wr.emitStmt(
                    Op.STMTx1_STORE_GLOBAL,
                    literal(this.packedIndex),
                    src
                )
            else
                wr.emitStmt(
                    Op.STMTx1_STORE_LOCAL,
                    literal(this.packedIndex),
                    src
                )
        } else {
            wr.emitStmt(
                Op.STMTx2_STORE_CLOSURE,
                literal(this.getClosureIndex()),
                literal(lev),
                src
            )
        }
    }
    toString() {
        return `var ${this.getName()}`
    }
    debugInfo(): VarDebugInfo {
        return {
            name: this.getName(),
            type: vkindToDbg(this.vkind),
        }
    }
}

function vkindToDbg(vkind: VariableKind): DebugVarType {
    switch (vkind) {
        case VariableKind.Global:
            return "glb"
        case VariableKind.ThisParam:
        case VariableKind.Parameter:
            return "arg"
        case VariableKind.Cached:
            return "tmp"
        case VariableKind.Local:
            return "loc"
        default:
            return "tmp"
    }
}

class BufferLit extends Cell {
    constructor(
        definition: ts.VariableDeclaration,
        scope: Cell[],
        public litValue: Uint8Array
    ) {
        super(definition, scope)
    }
    emit(wr: OpWriter): Value {
        return wr.emitString(this.litValue)
    }
    toString() {
        return `bufferLit ${this.getName()}`
    }
}

class FunctionDecl extends Cell {
    proc: Procedure

    numCtorArgs: number
    baseCtor: FunctionDecl

    constructor(definition: TsFunctionDecl, scope: FunctionDecl[]) {
        super(definition, scope)
    }
    emit(wr: OpWriter): Value {
        const prog = wr.prog as Program
        return prog.getFunctionProc(this).reference(wr)
    }
    toString() {
        return `function ${this.getName()}`
    }
}

function idName(pat: Expr | ts.DeclarationName) {
    if (pat && ts.isIdentifier(pat)) return pat.text
    else return null
}

function unit() {
    return nonEmittable()
}

interface DsSymbol extends ts.Symbol {
    __ds_cell: Cell
}

function symCell(sym: ts.Symbol) {
    return (sym as DsSymbol)?.__ds_cell
}

class Procedure {
    writer: OpWriter
    index: number
    params: Variable[] = []
    locals: Variable[] = []
    users: ts.Node[] = []
    skipAccounting = false
    parentProc: Procedure
    nestedProcs: Procedure[] = []
    usesClosure = false
    loopStack: LoopLabels[] = []
    returnValue: CachedValue
    returnValueLabel: Label
    returnNoValueLabel: Label
    maxTryBlocks = 0
    mapVarOffset: (n: number) => number

    constructor(
        public parent: Program,
        public name: string,
        public sourceNode?: ts.Node,
        public isMethod?: boolean
    ) {
        if (!this.sourceNode) this.sourceNode = parent.lastNode
        this.index = this.parent.procs.length
        this.writer = new OpWriter(parent, `${this.name}_F${this.index}`)
        this.parent.procs.push(this)
        if (
            ts.isMethodDeclaration(this.sourceNode) ||
            ts.isClassDeclaration(this.sourceNode)
        )
            this.isMethod = true
    }
    get numargs() {
        return this.params.length
    }
    toString() {
        return this.writer.getAssembly()
    }
    get usesThis() {
        const p = this.params[0] as Variable
        return p?.vkind == VariableKind.ThisParam
    }
    finalize() {
        if (this.mapVarOffset) return false
        if (this.usesThis) this.writer.funFlags |= FunctionFlag.NEEDS_THIS
        this.mapVarOffset = this.writer.patchLabels(
            this.locals.length,
            this.numargs,
            this.maxTryBlocks
        )
        return true
    }
    args() {
        return this.params.slice() as Variable[]
    }
    useFrom(node: ts.Node) {
        if (this.users.indexOf(node) >= 0) return
        this.users.push(node)
    }
    debugInfo(): FunctionDebugInfo {
        this.writer._forceFinStmt()
        const slots: VarDebugInfo[] = []
        for (const v of this.params.concat(this.locals)) {
            slots[v.getClosureIndex()] = v.debugInfo()
        }
        const numslots = this.writer.numSlots()
        for (let i = 0; i < numslots; ++i) {
            if (!slots[i])
                slots[i] = {
                    name: `_tmp${i}`,
                    type: "tmp",
                }
        }
        return {
            name: this.name,
            location: this.sourceNode
                ? this.parent.getSrcLocation(this.sourceNode)
                : undefined,
            startpc: this.writer.offsetInImg,
            size: this.writer.size,
            users: this.users.map(u => this.parent.getSrcLocation(u)),
            slots,
        }
    }

    addNestedProc(proc: Procedure) {
        this.nestedProcs.push(proc)
        proc.parentProc = this
    }

    dotPrototype(wr: OpWriter) {
        return wr.builtInMember(this.reference(wr), BuiltInString.PROTOTYPE)
    }

    reference(wr: OpWriter) {
        return wr.emitExpr(Op.EXPRx_STATIC_FUNCTION, literal(this.index))
    }

    referenceAsClosure(wr: OpWriter) {
        return wr.emitExpr(Op.EXPRx_MAKE_CLOSURE, literal(this.index))
    }

    callMe(wr: OpWriter, args: Value[], op = OpCall.SYNC) {
        const fn = this.reference(wr)
        if (op == OpCall.SYNC) wr.emitCall(fn, ...args)
        else
            wr.emitCall(
                wr.builtInMember(fn, BuiltInString.START),
                literal(op),
                ...args
            )
    }
    pushTryBlock(stmt: ts.TryStatement) {
        this.loopStack.push({ tryBlock: stmt })
        this.maxTryBlocks = Math.max(
            this.maxTryBlocks,
            this.loopStack.filter(b => !!b.tryBlock).length
        )
    }
}

type Expr = ts.Expression | ts.TemplateLiteralLikeNode
type FunctionLike =
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration

const mathConst: SMap<number> = {
    E: Math.E,
    PI: Math.PI,
    LN10: Math.LN10,
    LN2: Math.LN2,
    LOG2E: Math.LOG2E,
    LOG10E: Math.LOG10E,
    SQRT1_2: Math.SQRT1_2,
    SQRT2: Math.SQRT2,
}

function throwError(expr: ts.Node, msg: string): never {
    const err = new Error(msg)
    // console.log(err.stack)
    ;(err as any).sourceNode = expr
    throw err
}

interface LoopLabels {
    tryBlock?: ts.TryStatement
    labelSym?: ts.Symbol
    topLbl?: Label
    continueLbl?: Label
    breakLbl?: Label
}

interface ProtoDefinition {
    className: string
    methodName: string
    names: string[]
    methodDecl?: ts.MethodDeclaration
    protoUpdate?: ts.BinaryExpression
    emitted?: boolean
}

interface CallLike {
    position: ts.Node
    compiledCallExpr?: Value
    callexpr: Expr
    arguments: Expr[]
}

export interface CompileFlags {
    library?: boolean
    allFunctions?: boolean
    allPrototypes?: boolean
    traceBuiltin?: boolean
    traceProto?: boolean
}

function trace(...args: any) {
    console.debug("\u001b[32mTRACE:", ...args, "\u001b[0m")
}

export const compileFlagHelp: Record<string, string> = {
    library: "generate library (in .json format)",
    allFunctions:
        "compile-in all `function ...() { }` top-level declarations, used or not",
    allPrototypes:
        "compile-in all `object.method = function ...` assignments, used or not",
    traceBuiltin: "trace unresolved built-in functions",
    traceProto: "trace tree-shaking of prototypes",
}

class Program implements TopOpWriter {
    bufferLits: BufferLit[] = []
    roles: Role[] = []
    functions: FunctionDecl[] = []
    globals: Variable[] = []
    tree: ts.Program
    checker: ts.TypeChecker
    mainFile: ts.SourceFile
    procs: Procedure[] = []
    lastNode: ts.Node
    floatLiterals: number[] = []
    asciiLiterals: string[] = []
    utf8Literals: string[] = []
    bufferLiterals: Uint8Array[] = []
    writer: OpWriter
    proc: Procedure
    accountingProc: Procedure
    sysSpec: jdspec.ServiceSpec
    serviceSpecs: Record<string, jdspec.ServiceSpec>
    enums: Record<string, jdspec.EnumInfo> = {}
    protoDefinitions: ProtoDefinition[] = []
    usedMethods: Record<string, boolean> = {}
    resolverParams: number[]
    prelude: Record<string, string>
    numErrors = 0
    mainProc: Procedure
    protoProc: Procedure
    cloudRole: Role
    cloudMethod429: Label
    onStart: DelayedCodeSection
    flags: CompileFlags = {}
    isLibrary: boolean
    srcFiles: SrcFile[] = []
    diagnostics: DevsDiagnostic[] = []
    startServices: BaseServiceConfig[] = []

    constructor(public host: Host, public _source: string) {
        this.serviceSpecs = {}
        const specs = host.getSpecs()
        for (const sp of specs) {
            this.serviceSpecs[sp.camelName] = sp
            for (const en of Object.keys(sp.enums)) {
                const n = upperCamel(sp.camelName) + upperCamel(en)
                this.enums["#" + n] = sp.enums[en]
            }
        }
        this.sysSpec = this.serviceSpecs["system"]
        this.prelude = preludeFiles(specs)
    }

    get hasErrors() {
        return this.numErrors > 0
    }

    getSource(fn: string) {
        if (!fn || fn == this.host.mainFileName?.()) return this._source
        return this.prelude[fn] || ""
    }

    addString(str: string) {
        let isAscii = true
        for (let i = 0; i < str.length; ++i)
            if (str.charCodeAt(i) > 127 || str.charCodeAt(i) == 0) {
                isAscii = false
                break
            }
        let idx = BUILTIN_STRING__VAL.indexOf(str)
        if (idx >= 0) return idx | (StrIdx.BUILTIN << StrIdx._SHIFT)
        if (isAscii && str.length < 50) {
            idx = addUnique(this.asciiLiterals, str)
            return idx | (StrIdx.ASCII << StrIdx._SHIFT)
        } else
            return (
                addUnique(this.utf8Literals, str) |
                (StrIdx.UTF8 << StrIdx._SHIFT)
            )
    }

    addBuffer(buf: Uint8Array) {
        for (let i = 0; i < this.bufferLiterals.length; ++i) {
            const ss = this.bufferLiterals[i]
            if (bufferEq(buf, ss)) return i
        }
        this.bufferLiterals.push(buf)
        return this.bufferLiterals.length - 1
    }

    addFloat(f: number): number {
        return addUnique(this.floatLiterals, f)
    }

    getSrcLocation(node: ts.Node): SrcLocation {
        const sf = node.getSourceFile() as ts.SourceFile & {
            __ds_srcidx: number
            __ds_srcoffset: number
        }
        if (sf.__ds_srcidx === undefined) {
            let idx = this.srcFiles.findIndex(s => s.path == sf.fileName)
            if (idx < 0) {
                idx = this.srcFiles.length
                this.srcFiles.push({
                    path: sf.fileName,
                    length: sf.text.length,
                    text: sf.text,
                })
            }
            sf.__ds_srcidx = idx
            let off = 0
            for (let i = 0; i < idx; ++i) off += this.srcFiles[i].length
            sf.__ds_srcoffset = off
        }
        let pos = node.getStart(sf, false)
        const endp = node.getEnd()
        return [pos + sf.__ds_srcoffset, endp - pos]
    }

    printDiag(diag: ts.Diagnostic) {
        if (diag.category == ts.DiagnosticCategory.Error) this.numErrors++

        const jdiag: DevsDiagnostic = {
            ...diag,
            filename: this.host?.mainFileName() || "main.ts",
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 1,
            formatted: formatDiagnostics([diag]),
        }

        if (diag.file) {
            const st = diag.file.getLineAndCharacterOfPosition(diag.start)
            const en = diag.file.getLineAndCharacterOfPosition(
                diag.start + diag.length
            )
            jdiag.line = st.line + 1
            jdiag.column = st.character + 1
            jdiag.endLine = en.line + 1
            jdiag.endColumn = en.character + 1
            jdiag.filename = diag.file.fileName
        }
        this.diagnostics.push(sanitizeDiagnostic(jdiag))
        if (this.host.error) this.host.error(jdiag)
        else console.error(jdiag.formatted)
    }

    reportError(node: ts.Node, msg: string): Value {
        const diag: ts.Diagnostic = {
            category: ts.DiagnosticCategory.Error,
            messageText: msg,
            code: 9999,
            file: node.getSourceFile(),
            start: node.getStart(),
            length: node.getWidth(),
        }
        this.printDiag(diag)
        return unit()
    }

    describeCell(ff: string, idx: number): string {
        switch (ff) {
            case "R":
                return this.roles[idx]?.getName()
            case "B":
                return toHex(this.bufferLiterals[idx])
            case "U":
                return JSON.stringify(this.utf8Literals[idx])
            case "A":
                return JSON.stringify(this.asciiLiterals[idx])
            case "I":
                return JSON.stringify(BUILTIN_STRING__VAL[idx])
            case "O":
                return BUILTIN_OBJECT__VAL[idx] || "???"
            case "L":
                return "" // local
            case "G":
                return this.globals[idx]?.getName()
            case "D":
                return this.floatLiterals[idx] + ""
            case "F":
                return this.procs[idx]?.name
        }
    }

    private emitSleep(ms: number) {
        const wr = this.writer
        wr.emitCall(wr.dsMember(BuiltInString.SLEEPMS), literal(ms))
    }

    private withProcedure(proc: Procedure, f: (wr: OpWriter) => void) {
        assert(!!proc)
        const prevProc = this.proc
        const prevAcc = this.accountingProc
        try {
            this.proc = proc
            if (!proc.skipAccounting) this.accountingProc = proc
            this.writer = proc.writer
            this.withLocation(proc.sourceNode, f)
        } finally {
            this.proc = prevProc
            if (prevProc) this.writer = prevProc.writer
            this.accountingProc = prevAcc
        }
    }

    private forceName(pat: ts.Expression | ts.DeclarationName) {
        const r = idName(pat)
        if (!r) throwError(pat, "only simple identifiers supported")
        return r
    }

    private lookupRoleSpec(expr: ts.Node, serv: string) {
        const r = this.serviceSpecs.hasOwnProperty(serv)
            ? this.serviceSpecs[serv]
            : undefined
        if (!r) throwError(expr, "no such service: " + serv)
        return r
    }

    private toLiteralJSON(node: ts.Expression): any {
        if (this.isStringLiteral(node)) return node.text
        if (ts.isNumericLiteral(node)) return parseFloat(node.text)
        if (node.kind == SK.NullKeyword) return null

        if (ts.isArrayLiteralExpression(node))
            return node.elements.map(e => this.toLiteralJSON(e))

        if (ts.isObjectLiteralExpression(node)) {
            const json: Record<string, any> = {}
            for (const prop of node.properties) {
                if (!ts.isPropertyAssignment(prop))
                    throwError(
                        prop,
                        `only simple property assignments supported`
                    )
                const id = this.forceName(prop.name)
                const val = this.toLiteralJSON(prop.initializer)
                if (val === undefined)
                    throwError(
                        prop.initializer,
                        `only literals supported currently`
                    )
                json[id] = val
            }
            return json
        }

        throwError(node, `expecting JSON literal here`)
    }

    private parseRole(decl: ts.VariableDeclaration): Cell {
        if (this.getCellAtLocation(decl)) return

        const expr = decl.initializer

        const buflit = this.bufferLiteral(expr)
        if (buflit)
            return this.assignCell(
                decl,
                new BufferLit(decl, this.bufferLits, buflit)
            )

        if (!expr) return null

        const startPref = '#"@devicescript/servers".start'

        if (
            ts.isCallExpression(expr) &&
            this.nodeName(expr.expression)?.startsWith(startPref)
        ) {
            this.requireArgs(expr, 1)
            const arg = expr.arguments[0]
            const obj: BaseServiceConfig = this.toLiteralJSON(arg)
            if (!obj || typeof obj != "object")
                throwError(arg, `expecting { ... }`)
            const specName = this.lowerFirst(
                this.nodeName(expr.expression).slice(startPref.length)
            )
            obj.service = specName
            const spec = this.lookupRoleSpec(arg, specName)
            if (!obj.name) obj.name = this.forceName(decl.name)
            this.startServices.push(obj)
            const role = new Role(this, decl, this.roles, spec, obj.name)
            return this.assignCell(decl, role)
        }

        if (ts.isNewExpression(expr)) {
            const spec = this.specFromTypeName(
                expr.expression,
                this.nodeName(expr.expression),
                true
            )
            if (spec) {
                this.requireArgs(expr, 0)
                return this.assignCell(
                    decl,
                    new Role(this, decl, this.roles, spec)
                )
            }
        }

        return null
    }

    private emitStore(trg: Variable, src: Value) {
        assert(trg instanceof Variable)
        trg.store(this.writer, src, this.getClosureLevel(trg))
    }

    private skipInit(decl: ts.VariableDeclaration) {
        if (this.isTopLevel(decl) && idName(decl.name)) {
            const cell = this.getCellAtLocation(decl)
            return !(cell instanceof Variable)
        }
        return false
    }

    private getPropName(pn: ts.PropertyName | ts.BindingName) {
        if (ts.isIdentifier(pn) || ts.isStringLiteral(pn)) return pn.text
        throwError(pn, "unsupported property name")
    }

    private assignToId(id: ts.Identifier, init: Value) {
        this.emitStore(this.getVarAtLocation(id), init)
    }

    private cloneObj(obj: Value) {
        const wr = this.writer
        wr.emitStmt(Op.STMT0_ALLOC_MAP)
        wr.emitCall(wr.objectMember(BuiltInString.ASSIGN), this.retVal(), obj)
        return this.retVal()
    }

    private assignToBindingElement(
        bindingElt: ts.BindingElement,
        obj: CachedValue,
        usedFields: string[]
    ) {
        const wr = this.writer
        const bindingName = bindingElt.name

        if (bindingElt.dotDotDotToken) {
            const spr = wr.cacheValue(this.cloneObj(obj.emit()))

            for (const pn of usedFields)
                wr.emitStmt(
                    Op.STMT2_INDEX_DELETE,
                    spr.emit(),
                    wr.emitString(pn)
                )

            if (!ts.isIdentifier(bindingName))
                throwError(bindingName, "unsupported spread")
            this.assignToId(bindingName, spr.finalEmit())
            return
        }

        const pname = this.getPropName(
            bindingElt.propertyName ?? bindingElt.name
        )
        usedFields.push(pname)

        const val = wr.emitIndex(obj.emit(), wr.emitString(pname))
        this.finishBindingAssignment(bindingElt, val)
    }

    private finishBindingAssignment(bindingElt: ts.BindingElement, val: Value) {
        const bindingName = bindingElt.name

        if (bindingElt.initializer)
            throwError(
                bindingElt,
                "default values in bindings not supported yet"
            )

        if (ts.isIdentifier(bindingName)) {
            this.assignToId(bindingName, val)
        } else if (ts.isObjectBindingPattern(bindingName)) {
            const obj2 = this.writer.cacheValue(val)
            const used: string[] = []
            for (const elt of bindingName.elements) {
                this.assignToBindingElement(elt, obj2, used)
            }
            obj2.free()
        } else {
            throwError(bindingName, "invalid binding elt")
        }
    }

    private assignToArrayBindingElement(
        bindingElt: ts.ArrayBindingElement,
        obj: CachedValue,
        index: number
    ) {
        if (ts.isOmittedExpression(bindingElt)) return

        const wr = this.writer
        const bindingName = bindingElt.name

        if (bindingElt.dotDotDotToken) {
            const spl = wr.emitIndex(obj.emit(), wr.emitString("slice"))
            wr.emitCall(spl, literal(index))
            if (!ts.isIdentifier(bindingName))
                throwError(bindingName, "unsupported spread")
            this.assignToId(bindingName, this.retVal())
            return
        }

        const val = wr.emitIndex(obj.emit(), literal(index))
        this.finishBindingAssignment(bindingElt, val)
    }

    private isLoop(node: ts.Node) {
        switch (node.kind) {
            case SK.WhileStatement:
            case SK.DoStatement:
            case SK.ForStatement:
            case SK.ForOfStatement:
            case SK.ForInStatement:
                return true
            default:
                return false
        }
    }

    private isFundecl(node: ts.Node) {
        switch (node.kind) {
            case SK.FunctionDeclaration:
            case SK.FunctionExpression:
            case SK.ArrowFunction:
                return true
            default:
                return false
        }
    }

    private isInLoop(node: ts.Node) {
        while (node) {
            if (this.isLoop(node)) return true
            node = node.parent
            if (node && this.isFundecl(node)) return false
        }
        return false
    }

    private emitVariableDeclarationList(decls: ts.VariableDeclarationList) {
        for (const decl of decls.declarations) {
            this.assignVariableCells(decl) // just in case

            if (this.skipInit(decl)) continue

            let init: Value = null

            if (decl.initializer) init = this.emitExpr(decl.initializer)
            else if (this.isInLoop(decl)) init = literal(null)

            if (!init) continue

            if (ts.isIdentifier(decl.name)) {
                this.assignToId(decl.name, init)
            } else {
                const obj = this.writer.cacheValue(init)
                if (ts.isObjectBindingPattern(decl.name)) {
                    const used: string[] = []
                    for (const elt of decl.name.elements)
                        this.assignToBindingElement(elt, obj, used)
                } else if (ts.isArrayBindingPattern(decl.name)) {
                    let idx = 0
                    for (const elt of decl.name.elements) {
                        this.assignToArrayBindingElement(elt, obj, idx++)
                    }
                } else {
                    throwError(decl, "unsupported destructuring")
                }
                obj.free()
            }
        }
    }

    private emitVariableStatement(decls: ts.VariableStatement) {
        this.emitVariableDeclarationList(decls.declarationList)
    }

    private valueIsAlwaysFalse(v: Value) {
        if (v.isLiteral) return v.numValue == 0
        return v.op == Op.EXPR0_FALSE || v.op == Op.EXPR0_NULL
    }

    private valueIsAlwaysTrue(v: Value) {
        if (v.isLiteral) return v.numValue != 0 && !isNaN(v.numValue)
        return v.op == Op.EXPR0_TRUE
    }

    private emitIfStatement(stmt: ts.IfStatement) {
        const cond = this.emitExpr(stmt.expression)
        if (this.valueIsAlwaysFalse(cond)) {
            if (stmt.elseStatement) this.emitStmt(stmt.elseStatement)
        } else if (this.valueIsAlwaysTrue(cond)) {
            this.emitStmt(stmt.thenStatement)
        } else {
            this.writer.emitIfAndPop(
                cond,
                () => this.emitStmt(stmt.thenStatement),
                stmt.elseStatement
                    ? () => this.emitStmt(stmt.elseStatement)
                    : null
            )
        }
    }

    private emitForStatement(stmt: ts.ForStatement) {
        const wr = this.writer

        const loop = this.mkLoopLabels(stmt)

        if (stmt.initializer) {
            if (ts.isVariableDeclarationList(stmt.initializer))
                this.emitVariableDeclarationList(stmt.initializer)
            else {
                this.emitIgnoredExpression(stmt.initializer)
            }
        }

        wr.emitLabel(loop.topLbl)

        const cond = this.emitExpr(stmt.condition)
        wr.emitJumpIfFalse(loop.breakLbl, cond)

        try {
            this.proc.loopStack.push(loop)
            this.emitStmt(stmt.statement)
            wr.emitLabel(loop.continueLbl)
            if (stmt.incrementor) this.emitIgnoredExpression(stmt.incrementor)
        } finally {
            this.proc.loopStack.pop()
        }

        wr.emitJump(loop.topLbl)
        wr.emitLabel(loop.breakLbl)
    }

    /*
        try { BODY }
        catch (e) { CATCH }
        finally { FINALLY }

        ==>
            try l_finally
            try l_catch
            BODY
            end_try l_after

        l_catch:
            catch()
            e := retval()
            CATCH
        l_after: 
        l_finally:
            finally()
            tmp := retval()
            FINALLY
            re_throw tmp
    */

    private emitTryCatchStatement(stmt: ts.TryStatement) {
        if (!stmt.catchClause) return this.emitBlock(stmt.tryBlock)

        const wr = this.writer

        const after = wr.mkLabel("aftertry")
        const catchLbl = wr.mkLabel("catch")
        wr.emitTry(catchLbl)

        this.proc.pushTryBlock(stmt)
        try {
            this.emitBlock(stmt.tryBlock)
        } finally {
            this.proc.loopStack.pop()
            wr.emitEndTry(after)
        }

        wr.emitLabel(catchLbl)
        wr.emitStmt(Op.STMT0_CATCH)
        const decl = stmt.catchClause.variableDeclaration
        if (decl) {
            this.assignVariableCells(decl)
            this.emitStore(this.getVarAtLocation(decl), this.retVal())
        }
        this.emitBlock(stmt.catchClause.block)

        wr.emitLabel(after)
    }

    private emitTryStatement(stmt: ts.TryStatement) {
        if (!stmt.finallyBlock) return this.emitTryCatchStatement(stmt)

        // try ... catch ... finally ...
        const wr = this.writer

        const finallyLbl = wr.mkLabel("finally")
        wr.emitTry(finallyLbl)
        this.proc.pushTryBlock(stmt)

        try {
            this.emitTryCatchStatement(stmt)
        } finally {
            this.proc.loopStack.pop()
        }

        wr.emitLabel(finallyLbl)
        wr.emitStmt(Op.STMT0_FINALLY)
        const exn = wr.cacheValue(this.retVal(), true)
        this.emitBlock(stmt.finallyBlock)
        wr.emitStmt(Op.STMT1_RE_THROW, exn.finalEmit())
    }

    private emitThrowStatement(stmt: ts.ThrowStatement) {
        const wr = this.writer
        wr.emitStmt(Op.STMT1_THROW, this.emitExpr(stmt.expression))
    }

    private emitBlock(stmt: ts.Block) {
        let hadFun = false
        let stmts = stmt.statements.slice()
        for (const s of stmts) {
            this.assignCellsToStmt(s)
            if (ts.isFunctionDeclaration(s)) hadFun = true
        }
        if (hadFun) {
            stmts = stmts
                .filter<ts.Statement>(ts.isFunctionDeclaration)
                .concat(stmts.filter(s => !ts.isFunctionDeclaration(s)))
        }

        for (const s of stmts) this.emitStmt(s)
    }

    private emitBreakContStatement(stmt: ts.BreakOrContinueStatement) {
        const sym = stmt.label ? this.getSymAtLocation(stmt.label) : null
        let numTry = 0
        const wr = this.writer
        for (let i = this.proc.loopStack.length - 1; i >= 0; i--) {
            const loop = this.proc.loopStack[i]
            if (loop.tryBlock) {
                numTry++
                continue
            }
            if (sym && sym != loop.labelSym) continue
            const lbl =
                stmt.kind == SK.ContinueStatement
                    ? loop.continueLbl
                    : loop.breakLbl
            if (numTry) wr.emitThrowJmp(lbl, numTry)
            else wr.emitJump(lbl)
            return
        }
        throwError(stmt, "loop not found")
    }

    private mkLoopLabels(stmt: ts.IterationStatement) {
        const wr = this.writer
        const res: LoopLabels = {
            topLbl: wr.mkLabel("top"),
            continueLbl: wr.mkLabel("continue"),
            breakLbl: wr.mkLabel("break"),
        }
        if (ts.isLabeledStatement(stmt.parent)) {
            res.labelSym = this.getSymAtLocation(stmt.parent.label)
        }
        return res
    }

    private emitForOfStatement(stmt: ts.ForOfStatement) {
        const wr = this.writer

        const loop = this.mkLoopLabels(stmt)

        if (
            stmt.awaitModifier ||
            !stmt.initializer ||
            !ts.isVariableDeclarationList(stmt.initializer) ||
            stmt.initializer.declarations.length != 1
        )
            throwError(stmt, "only for (let/const x of ...) supported")

        const decl = stmt.initializer.declarations[0]

        const coll = wr.cacheValue(this.emitExpr(stmt.expression), true)
        const idx = wr.cacheValue(literal(0), true)

        this.emitVariableDeclarationList(stmt.initializer)
        const elt = this.getVarAtLocation(decl)

        wr.emitLabel(loop.topLbl)

        const cond = wr.emitExpr(
            Op.EXPR2_LT,
            idx.emit(),
            wr.emitIndex(coll.emit(), wr.emitString("length"))
        )
        wr.emitJumpIfFalse(loop.breakLbl, cond)

        try {
            const collVal = coll.emit()
            const idxVal = idx.emit()
            this.emitStore(elt, wr.emitIndex(collVal, idxVal))
            this.proc.loopStack.push(loop)
            this.emitStmt(stmt.statement)
            wr.emitLabel(loop.continueLbl)
            idx.store(wr.emitExpr(Op.EXPR2_ADD, idx.emit(), literal(1)))
        } finally {
            this.proc.loopStack.pop()
            coll.free()
            idx.free()
        }

        wr.emitJump(loop.topLbl)
        wr.emitLabel(loop.breakLbl)
    }

    private emitWhileStatement(stmt: ts.WhileStatement) {
        const wr = this.writer

        const loop = this.mkLoopLabels(stmt)

        wr.emitLabel(loop.continueLbl)
        wr.emitLabel(loop.topLbl)
        const cond = this.emitExpr(stmt.expression)
        wr.emitJumpIfFalse(loop.breakLbl, cond)

        try {
            this.proc.loopStack.push(loop)
            this.emitStmt(stmt.statement)
        } finally {
            this.proc.loopStack.pop()
        }

        wr.emitJump(loop.continueLbl)
        wr.emitLabel(loop.breakLbl)
    }

    private finishRetVal() {
        const wr = this.writer
        if (this.proc.returnValueLabel) {
            wr.emitLabel(this.proc.returnValueLabel)
            wr.emitStmt(Op.STMT1_RETURN, this.proc.returnValue.finalEmit())
        }
        if (this.proc.returnNoValueLabel) {
            wr.emitLabel(this.proc.returnNoValueLabel)
            wr.emitStmt(Op.STMT1_RETURN, literal(null))
        }
    }

    private emitReturnStatement(stmt: ts.ReturnStatement) {
        const wr = this.writer
        const numTry = this.proc.loopStack.filter(l => !!l.tryBlock).length
        if (stmt.expression) {
            if (wr.ret) oops("return with value not supported here")
            const expr = this.emitExpr(stmt.expression)
            if (numTry) {
                if (!this.proc.returnValue) {
                    this.proc.returnValue = wr.cacheValue(expr, true)
                    this.proc.returnValueLabel = wr.mkLabel("retVal")
                } else this.proc.returnValue.store(expr)
                wr.emitThrowJmp(this.proc.returnValueLabel, numTry)
            } else {
                wr.emitStmt(Op.STMT1_RETURN, expr)
            }
        } else {
            if (wr.ret) {
                this.writer.emitThrowJmp(this.writer.ret, numTry)
            } else {
                if (numTry) {
                    if (!this.proc.returnNoValueLabel)
                        this.proc.returnNoValueLabel = wr.mkLabel("retNoVal")
                    wr.emitThrowJmp(this.proc.returnNoValueLabel, numTry)
                } else {
                    wr.emitStmt(Op.STMT1_RETURN, literal(null))
                }
            }
        }
    }

    private lowerFirst(r: string) {
        return r[0].toLowerCase() + r.slice(1)
    }

    private specFromTypeName(
        expr: ts.Node,
        nm?: string,
        optional = false
    ): jdspec.ServiceSpec {
        if (!nm) nm = this.nodeName(expr)
        if (nm && nm.startsWith("#ds.")) {
            let r = this.lowerFirst(nm.slice(4))
            if (r == "condition") r = "deviceScriptCondition"
            return this.lookupRoleSpec(expr, r)
        } else {
            if (optional) return null
            throwError(expr, `type name not understood: ${nm}`)
        }
    }

    private emitCtorAssignments(
        cls: ts.ClassLikeDeclaration,
        ctor?: ts.ConstructorDeclaration
    ) {
        assert(this.proc.usesThis)
        this.proc.writer.funFlags |=
            FunctionFlag.IS_CTOR | FunctionFlag.NEEDS_THIS
        for (const mem of cls.members) {
            if (!ts.isPropertyDeclaration(mem)) continue
            const id = this.forceName(mem.name)
            if (mem.initializer)
                this.withLocation(mem, wr => {
                    wr.emitStmt(
                        Op.STMT3_INDEX_SET,
                        this.emitThisExpression(mem),
                        wr.emitString(id),
                        this.emitExpr(mem.initializer)
                    )
                })
        }
        for (const param of ctor?.parameters ?? []) {
            if (ts.isParameterPropertyDeclaration(param, ctor)) {
                this.withLocation(param, wr => {
                    wr.emitStmt(
                        Op.STMT3_INDEX_SET,
                        this.emitThisExpression(param),
                        wr.emitString(this.forceName(param.name)),
                        this.getVarAtLocation(param).emit(wr)
                    )
                })
            }
        }
    }

    private emitCtor(cls: ts.ClassLikeDeclaration, proc: Procedure) {
        const ctor = cls.members.find(ts.isConstructorDeclaration)
        if (ctor) return this.emitFunction(ctor, proc)
        else {
            // generate implicit ctor
            try {
                const fdecl = this.getCellAtLocation(cls) as FunctionDecl
                assert(fdecl instanceof FunctionDecl)
                this.withProcedure(proc, wr => {
                    this.addParameter(proc, "this")
                    const params = range(fdecl.numCtorArgs).map(i =>
                        this.addParameter(proc, "a" + i)
                    )
                    if (fdecl.baseCtor) {
                        wr.emitCall(
                            wr.emitExpr(
                                Op.EXPR2_BIND,
                                fdecl.baseCtor.emit(wr),
                                this.emitThisExpression(cls)
                            ),
                            ...params.map(p => p.emit(wr))
                        )
                    } else {
                        assert(params.length == 0)
                    }
                    this.emitCtorAssignments(cls)
                    wr.emitStmt(Op.STMT1_RETURN, literal(null))
                    this.finishRetVal()
                    this.finalizeProc(proc)
                })
            } catch (e) {
                this.handleException(cls, e)
            }
            return proc
        }
    }

    private isLeafCtor(stmt: FunctionLike): stmt is ts.ConstructorDeclaration {
        if (!ts.isConstructorDeclaration(stmt)) return false
        const decl = this.getCellAtLocation(stmt.parent) as FunctionDecl
        return decl.baseCtor == null
    }

    private emitFunction(stmt: FunctionLike, proc: Procedure) {
        try {
            this.withProcedure(proc, () => {
                this.emitParameters(stmt, proc)
                // if there is a base class (non-leaf) then ctor assignments emitted right after super() call
                if (this.isLeafCtor(stmt))
                    this.emitCtorAssignments(stmt.parent, stmt)
                this.emitFunctionBody(stmt, proc)
            })
        } catch (e) {
            this.handleException(stmt, e)
        }
        return proc
    }

    private emitNested(proc: Procedure) {
        for (const p of proc.nestedProcs) {
            if (
                p.sourceNode &&
                (ts.isFunctionDeclaration(p.sourceNode) ||
                    ts.isFunctionExpression(p.sourceNode) ||
                    ts.isArrowFunction(p.sourceNode))
            )
                this.emitFunction(p.sourceNode, p)
            else oops("bad sourceNode")
        }
    }

    private finalizeProc(proc: Procedure) {
        try {
            if (!proc.finalize()) return
        } catch (e) {
            this.handleException(proc.sourceNode, e)
            return
        }
        this.emitNested(proc)
    }

    private emitFunctionBody(stmt: FunctionLike, proc: Procedure) {
        if (ts.isBlock(stmt.body)) {
            this.emitStmt(stmt.body)
            if (!this.writer.justHadReturn())
                this.writer.emitStmt(Op.STMT1_RETURN, literal(null))
        } else {
            this.writer.emitStmt(Op.STMT1_RETURN, this.emitExpr(stmt.body))
        }
        this.finishRetVal()

        this.finalizeProc(proc)
    }

    private addParameter(
        proc: Procedure,
        id: ts.ParameterDeclaration | string
    ) {
        const v = new Variable(
            typeof id == "string" ? null : id,
            VariableKind.Parameter,
            proc
        )
        if (typeof id == "string") v._name = id
        else this.assignCell(id, v)
        if (v.getName() == "this") v.vkind = VariableKind.ThisParam
        return v
    }

    private withLocation(node: ts.Node, f: (wr: OpWriter) => void) {
        const wr = this.writer

        if (!node) return f(wr)

        wr.locPush(this.getSrcLocation(node))
        try {
            f(wr)
        } finally {
            wr.locPop()
        }
    }

    private emitParameters(stmt: FunctionLike, proc: Procedure) {
        if (proc.isMethod && idName(stmt.parameters[0]?.name) != "this")
            this.addParameter(proc, "this")
        for (const paramdef of stmt.parameters) {
            if (paramdef.kind != SK.Parameter)
                throwError(
                    paramdef,
                    "only simple identifiers supported as parameters"
                )
            this.forceName(paramdef.name)
            this.addParameter(proc, paramdef)
        }
        for (const paramdef of stmt.parameters) {
            if (paramdef.initializer) {
                this.withLocation(paramdef, wr => {
                    const v = this.getVarAtLocation(paramdef)
                    wr.emitIfAndPop(
                        wr.emitExpr(Op.EXPR1_IS_NULL, v.emit(wr)),
                        () => {
                            this.emitStore(
                                v,
                                this.emitExpr(paramdef.initializer)
                            )
                        }
                    )
                })
            }
        }
    }

    getFunctionProc(fundecl: FunctionDecl) {
        if (fundecl.proc) return fundecl.proc
        const stmt = fundecl.definition as TsFunctionDecl
        fundecl.proc = new Procedure(this, fundecl.getName(), stmt)
        if (ts.isClassDeclaration(stmt))
            return this.emitCtor(stmt, fundecl.proc)
        else return this.emitFunction(stmt, fundecl.proc)
    }

    private emitFunctionDeclaration(stmt: ts.FunctionDeclaration) {
        const fundecl = this.functions.find(
            f => f.definition === stmt
        ) as FunctionDecl

        if (
            stmt.asteriskToken ||
            (stmt.modifiers && !stmt.modifiers.every(modifierOK))
        )
            throwError(stmt, "modifier not supported")

        if (!this.isTopLevel(stmt)) {
            this.emitStore(
                this.getVarAtLocation(stmt),
                this.emitFunctionExpr(stmt)
            )
            return
        }

        assert(!!fundecl || !!this.numErrors)

        if (fundecl) {
            if (
                this.flags.allFunctions ||
                (this.isLibrary && this.inMainFile(stmt))
            )
                this.getFunctionProc(fundecl)
        }

        function modifierOK(mod: ts.Modifier) {
            switch (mod.kind) {
                case SK.ExportKeyword:
                    return true
                default:
                    return false
            }
        }
    }

    private methodNames(sym: ts.Symbol) {
        const name = this.symName(sym)
        const names = [name]

        if (name == "#ds.RegisterNumber.onChange")
            names.push(
                "#ds.RegisterBuffer.onChange",
                "#ds.RegisterBool.onChange"
            )

        for (const baseSym of this.getBaseSyms(sym)) {
            names.push(this.symName(baseSym))
        }

        return names
    }

    private emitClassDeclaration(stmt: ts.ClassDeclaration) {
        const fdecl = this.getCellAtLocation(stmt) as FunctionDecl
        assert(fdecl instanceof FunctionDecl)

        let numCtorArgs: number = null

        for (const mem of stmt.members) {
            switch (mem.kind) {
                case SK.PropertyDeclaration:
                case SK.MethodDeclaration:
                case SK.Constructor:
                case SK.SemicolonClassElement:
                    break
                default:
                    throwError(mem, "unsupported class member")
            }

            if (ts.isMethodDeclaration(mem)) {
                const sym = this.getSymAtLocation(mem)
                this.protoDefinitions.push({
                    className: this.nodeName(stmt),
                    methodName: this.forceName(mem.name),
                    names: this.methodNames(sym),
                    methodDecl: mem,
                })
            } else if (ts.isConstructorDeclaration(mem)) {
                numCtorArgs = mem.parameters.length
            }
        }

        let baseDecl: FunctionDecl
        if (stmt.heritageClauses) {
            for (const cls of stmt.heritageClauses) {
                if (cls.token == SK.ImplementsKeyword) continue
                if (cls.token == SK.ExtendsKeyword) {
                    const tps = cls.types
                        .slice()
                        .map(e => this.checker.getTypeAtLocation(e))
                    if (tps.length != 1)
                        throwError(cls, "only single extends supported")
                    baseDecl = symCell(tps[0].symbol) as FunctionDecl
                    if (!(baseDecl instanceof FunctionDecl))
                        throwError(cls, "invalid extends")
                }
            }
        }

        assert(baseDecl == null || baseDecl.numCtorArgs != null)
        fdecl.numCtorArgs = numCtorArgs ?? baseDecl?.numCtorArgs ?? 0
        fdecl.baseCtor = baseDecl
    }

    private isTopLevel(node: ts.Node) {
        return !!(node as any)._devsIsTopLevel
    }

    private symSetCell(sym: ts.Symbol, cell: Cell) {
        const s = sym as DsSymbol
        assert(!s.__ds_cell || s.__ds_cell == cell || this.numErrors > 0)
        s.__ds_cell = cell
    }

    private assignCell<T extends Cell>(node: ts.NamedDeclaration, cell: T): T {
        const sym = this.checker.getSymbolAtLocation(node.name)
        assert(!!sym)
        this.symSetCell(sym, cell)
        return cell
    }

    private emitMethod(meth: ts.MethodDeclaration) {
        const proc = new Procedure(this, this.forceName(meth.name), meth)
        this.emitFunction(meth, proc)
        this.withLocation(meth, wr => {
            wr.emitStmt(
                Op.STMT3_INDEX_SET,
                this.ctorProc(meth.parent).dotPrototype(wr),
                wr.emitString(this.forceName(meth.name)),
                proc.reference(wr)
            )
        })
    }

    private ctorProc(
        cls: ts.ClassLikeDeclaration | ts.ObjectLiteralExpression
    ) {
        const ctordecl = this.getCellAtLocation(cls) as FunctionDecl
        assert(ctordecl instanceof FunctionDecl)
        return ctordecl.proc
    }

    private emitProtoAssigns() {
        const needsEmit = (p: ProtoDefinition) => {
            if (p.emitted) return false
            if (p.methodDecl && this.ctorProc(p.methodDecl.parent) == null)
                return false
            if (this.flags.allPrototypes) return true
            if (this.usedMethods["*" + p.methodName]) return true
            if (p.names.some(n => this.usedMethods[n])) return true
            return false
        }

        this.withProcedure(this.protoProc, () => {
            for (;;) {
                let numemit = 0
                for (const p of this.protoDefinitions) {
                    if (needsEmit(p)) {
                        p.emitted = true
                        numemit++
                        if (this.flags.traceProto) trace("EMIT upd", p.names[0])
                        if (p.methodDecl) this.emitMethod(p.methodDecl)
                        else
                            this.withLocation(p.protoUpdate, () =>
                                this.emitAssignmentExpression(
                                    p.protoUpdate,
                                    true
                                )
                            )
                    }
                }
                this.emitNested(this.protoProc)
                this.protoProc.nestedProcs = []

                if (numemit == 0) break
            }

            for (const fdecl of this.functions) {
                if (fdecl.baseCtor && fdecl.proc) {
                    assert(!!fdecl.baseCtor.proc)
                    this.withLocation(fdecl.definition, wr =>
                        wr.emitCall(
                            wr.objectMember(BuiltInString.SETPROTOTYPEOF),
                            fdecl.proc.dotPrototype(wr),
                            fdecl.baseCtor.proc.dotPrototype(wr)
                        )
                    )
                }
            }

            this.writer.emitStmt(Op.STMT1_RETURN, literal(null))
            this.finalizeProc(this.protoProc)
        })

        if (this.flags.traceProto) {
            for (const p of this.protoDefinitions) {
                if (!p.emitted) trace("skip upd", p.names[0])
            }
        }
    }

    private emitProgram(prog: ts.Program) {
        this.lastNode = this.mainFile
        this.mainProc = new Procedure(this, "main", this.mainFile)
        this.protoProc = new Procedure(this, "prototype", this.mainFile)

        this.onStart = new DelayedCodeSection("onStart", this.mainProc.writer)

        const stmts = ([] as ts.Statement[]).concat(
            ...prog
                .getSourceFiles()
                .map(file => (file.isDeclarationFile ? [] : file.statements))
        )

        stmts.forEach(markTopLevel)

        // pre-declare all functions and globals
        for (const s of stmts) {
            this.assignCellsToStmt(s)
        }

        this.roles.sort((a, b) => strcmp(a.getName(), b.getName()))
        this.roles.forEach((r, i) => {
            r._index = i
        })

        // make sure the cloud role is last
        this.cloudRole = new Role(
            this,
            null,
            this.roles,
            this.serviceSpecs["cloudAdapter"],
            "cloud"
        )

        this.withProcedure(this.mainProc, wr => {
            this.protoProc.callMe(wr, [])
            for (const s of stmts) this.emitStmt(s)
            this.onStart.finalizeRaw()
            this.writer.emitStmt(Op.STMT1_RETURN, literal(0))
            this.finalizeProc(this.mainProc)
            this.emitProtoAssigns()
        })

        if (!this.cloudRole.used) {
            const cl = this.roles.pop()
            assert(cl == this.cloudRole)
        }

        function markTopLevel(node: ts.Node) {
            ;(node as any)._devsIsTopLevel = true
            if (ts.isExpressionStatement(node)) markTopLevel(node.expression)
            else if (ts.isVariableStatement(node))
                node.declarationList.declarations.forEach(markTopLevel)
            else if (
                ts.isVariableDeclaration(node) &&
                !ts.isIdentifier(node.name)
            )
                node.name.elements.forEach(markTopLevel)
        }
    }

    private assignCellsToStmt(stmt: ts.Statement) {
        try {
            if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations)
                    try {
                        this.assignVariableCells(decl)
                    } catch (e) {
                        this.handleException(decl, e)
                    }
            } else if (ts.isFunctionDeclaration(stmt)) {
                if (this.getCellAtLocation(stmt)) return
                this.forceName(stmt.name)
                if (this.isTopLevel(stmt))
                    this.assignCell(
                        stmt,
                        new FunctionDecl(stmt, this.functions)
                    )
                else
                    this.assignCell(
                        stmt,
                        new Variable(stmt, VariableKind.Local, this.proc)
                    )
            } else if (ts.isClassDeclaration(stmt)) {
                if (this.getCellAtLocation(stmt)) return
                if (!stmt.name) throwError(stmt, "classes need names")
                if (!this.isTopLevel(stmt))
                    throwError(stmt, "only top-level classes supported")
                this.forceName(stmt.name)
                this.assignCell(stmt, new FunctionDecl(stmt, this.functions))
            }
        } catch (e) {
            this.handleException(stmt, e)
        }
    }

    private assignVariableCells(decl: ts.VariableDeclaration) {
        const topLevel = this.isTopLevel(decl)
        if (idName(decl.name) && topLevel) {
            if (this.parseRole(decl)) return
        }

        const doAssign = (decl: ts.VariableDeclaration | ts.BindingElement) => {
            if (ts.isIdentifier(decl.name)) {
                if (this.getCellAtLocation(decl)) return
                this.assignCell(
                    decl,
                    new Variable(
                        decl,
                        topLevel ? VariableKind.Global : VariableKind.Local,
                        topLevel ? this.globals : this.proc
                    )
                )
            } else if (ts.isObjectBindingPattern(decl.name)) {
                for (const elt of decl.name.elements) {
                    doAssign(elt)
                }
            } else if (ts.isArrayBindingPattern(decl.name)) {
                for (const elt of decl.name.elements) {
                    if (!ts.isOmittedExpression(elt)) doAssign(elt)
                }
            } else {
                throwError(decl, "unsupported binding")
            }
        }

        doAssign(decl)
    }

    private ignore(val: Value) {
        val.adopt()
    }

    private isForIgnored(expr: Expr) {
        if (expr.parent) {
            if (ts.isForStatement(expr.parent))
                return (
                    expr == expr.parent.initializer ||
                    expr == expr.parent.incrementor
                )
        }
        return false
    }

    private isIgnored(expr: Expr) {
        return (
            expr.parent &&
            (ts.isExpressionStatement(expr.parent) || this.isForIgnored(expr))
        )
    }

    private emitIgnoredExpression(expr: Expr) {
        this.ignore(this.emitExpr(expr))
        this.writer.assertNoTemps()
    }

    private emitExpressionStatement(stmt: ts.ExpressionStatement) {
        this.emitIgnoredExpression(stmt.expression)
    }

    private uniqueProcName(base: string) {
        let suff = 0
        while (this.procs.some(p => p.name == base + "_" + suff)) suff++
        return base + "_" + suff
    }

    private emitHandler(
        name: string,
        func: Expr,
        options: {
            every?: number
        } = {}
    ): Procedure {
        if (!ts.isArrowFunction(func))
            throwError(func, "arrow function expected here")
        const proc = new Procedure(this, this.uniqueProcName(name), func)
        proc.useFrom(func)
        proc.writer.ret = proc.writer.mkLabel("ret")
        if (func.parameters.length)
            throwError(func, "parameters not supported here")
        this.withProcedure(proc, wr => {
            this.emitParameters(func, proc)
            if (options.every) {
                this.emitSleep(options.every)
            }
            if (ts.isBlock(func.body)) {
                this.emitStmt(func.body)
            } else {
                this.ignore(this.emitExpr(func.body))
            }
            wr.emitLabel(wr.ret)
            if (options.every) wr.emitJump(wr.top)
            else {
                wr.emitStmt(Op.STMT1_RETURN, literal(null))
            }
            this.finalizeProc(proc)
        })
        return proc
    }

    private requireArgs(
        expr: ts.CallExpression | ts.NewExpression | CallLike,
        num: number
    ) {
        if (expr.arguments.length != num)
            throwError(
                (expr as any).position || expr,
                `${num} arguments required; got ${expr.arguments.length}`
            )
    }

    private requireTopLevel(expr: ts.Node) {
        if (!this.isTopLevel(expr))
            throwError(
                expr,
                "this can only be done at the top-level of the program"
            )
    }

    private parseFormat(expr: Expr): NumFmt {
        const str = this.stringLiteral(expr) || ""
        const m = /^([uif])(\d+)(\.\d+)?$/.exec(str.trim())
        if (!m)
            throwError(
                expr,
                `format descriptor ("u32", "i22.10", etc) expected`
            )
        let sz = parseInt(m[2])
        let shift = 0
        if (m[3]) {
            shift = parseInt(m[3].slice(1))
            sz += shift
        }

        let r: NumFmt

        switch (sz) {
            case 8:
                r = NumFmt.U8
                break
            case 16:
                r = NumFmt.U16
                break
            case 32:
                r = NumFmt.U32
                break
            case 64:
                r = NumFmt.U64
                break
            default:
                throwError(
                    expr,
                    `total format size is not one of 8, 16, 32, 64 bits`
                )
        }

        switch (m[1]) {
            case "u":
                break
            case "i":
                r += NumFmt.I8
                break
            case "f":
                if (shift) throwError(expr, `shifts not supported for floats`)
                r += NumFmt.F8
                break
            default:
                assert(false)
        }

        if (r == NumFmt.F8 || r == NumFmt.F16)
            throwError(expr, `f8 and f16 are not supported`)

        return r | (shift << 4)
    }

    private emitGenericCall(args: Expr[], fn: Value) {
        const wr = this.writer
        if (args.some(ts.isSpreadElement)) {
            wr.emitStmt(Op.STMT1_ALLOC_ARRAY, literal(0))
            const arr = wr.cacheValue(this.retVal())
            for (const a of args) {
                let expr: Value
                let meth = "push"
                if (ts.isSpreadElement(a)) {
                    expr = this.emitExpr(a.expression)
                    meth = "pushRange"
                } else {
                    expr = this.emitExpr(a)
                }
                wr.emitCall(wr.emitIndex(arr.emit(), wr.emitString(meth)), expr)
            }
            wr.emitStmt(Op.STMT2_CALL_ARRAY, fn, arr.finalEmit())
        } else {
            wr.emitCall(fn, ...this.emitArgs(args))
        }
        return this.retVal()
    }

    private emitMathCall(id: BuiltInString, ...args: Value[]) {
        const wr = this.writer
        wr.emitCall(wr.mathMember(id), ...args)
        return this.retVal()
    }

    private stringLiteral(expr: Expr) {
        if (this.isStringLiteral(expr)) return expr.text
        return undefined
    }

    private bufferLiteral(expr: Expr): Uint8Array {
        if (!expr) return undefined

        if (ts.isTaggedTemplateExpression(expr) && idName(expr.tag) == "hex") {
            if (!ts.isNoSubstitutionTemplateLiteral(expr.template))
                throwError(
                    expr,
                    "${}-expressions not supported in hex literals"
                )
            const hexbuf = expr.template.text.replace(/\s+/g, "").toLowerCase()
            if (hexbuf.length & 1) throwError(expr, "non-even hex length")
            if (!/^[0-9a-f]*$/.test(hexbuf))
                throwError(expr, "invalid characters in hex")
            return fromHex(hexbuf)
        }

        const cell = this.getCellAtLocation(expr)
        if (cell instanceof BufferLit) return cell.litValue

        return undefined
    }

    private bufferSize(v: Value) {
        const idx = v.args?.[0]?.numValue
        if (idx !== undefined)
            switch (v.op) {
                case Op.EXPRx_STATIC_BUFFER:
                    return this.bufferLiterals[idx].length
                case Op.EXPRx_STATIC_ASCII_STRING:
                    return this.asciiLiterals[idx].length
                case Op.EXPRx_STATIC_UTF8_STRING:
                    return strlen(this.utf8Literals[idx])
                case Op.EXPRx_STATIC_BUILTIN_STRING:
                    return BUILTIN_STRING__VAL[idx].length
            }
        return undefined
    }

    private emitStringOrBuffer(expr: Expr) {
        const stringLiteral = this.stringLiteral(expr)
        const wr = this.writer
        if (stringLiteral != undefined) {
            return wr.emitString(stringLiteral)
        } else {
            const buf = this.bufferLiteral(expr)
            if (buf) {
                return wr.emitString(buf)
            } else {
                throwError(expr, "expecting a string literal here")
            }
        }
    }

    private emitArgs(args: Expr[]) {
        return args.map(arg => this.emitExpr(arg))
    }

    private forceNumberLiteral(expr: Expr) {
        const tmp = this.emitExpr(expr)
        if (!tmp.isLiteral) throwError(expr, "number literal expected")
        return tmp.numValue
    }

    private isStringLike(expr: Expr) {
        return !!(
            this.checker.getTypeAtLocation(expr).getFlags() &
            ts.TypeFlags.StringLike
        )
    }

    private flattenPlus(arg: Expr): Expr[] {
        if (!this.isStringLike(arg)) return [arg]

        if (
            ts.isBinaryExpression(arg) &&
            arg.operatorToken.kind == SK.PlusToken
        ) {
            return this.flattenPlus(arg.left).concat(
                this.flattenPlus(arg.right)
            )
        } else if (ts.isTemplateExpression(arg)) {
            const r: Expr[] = []
            if (arg.head.text) r.push(arg.head)
            for (const span of arg.templateSpans) {
                r.push(span.expression)
                if (span.literal.text) r.push(span.literal)
            }
            return r
        } else {
            return [arg]
        }
    }

    private compileFormat(args: Expr[]) {
        let fmt = ""
        const fmtArgs: Expr[] = []
        const strval = (n: number) => {
            if (n <= 9) return "" + n
            return String.fromCharCode(0x61 + n - 9)
        }
        const pushArg = (arg: Expr) => {
            const str = this.stringLiteral(arg)
            if (str) {
                fmt += str.replace(/\{/g, "{{")
            } else {
                fmt += `{${strval(fmtArgs.length)}}`
                fmtArgs.push(arg)
            }
        }

        for (const arg of args) {
            if (fmt && !/[=:]$/.test(fmt)) fmt += " "
            const flat = this.flattenPlus(arg)
            if (flat.some(f => this.stringLiteral(f) != null)) {
                flat.forEach(pushArg)
            } else {
                pushArg(arg)
            }
        }

        const wr = this.writer
        wr.emitCall(
            wr.dsMember(BuiltInString.FORMAT),
            wr.emitString(fmt),
            ...this.emitArgs(fmtArgs)
        )
        return this.retVal()
    }

    private retVal() {
        return this.writer.emitExpr(Op.EXPR0_RET_VAL)
    }

    private symName(sym: ts.Symbol) {
        if (!sym) return null
        if (sym.flags & ts.SymbolFlags.Alias)
            sym = this.checker.getAliasedSymbol(sym)
        let r = this.checker.getFullyQualifiedName(sym)
        if (r && r.startsWith(`"${coreModule}"`))
            return "#ds." + r.slice(coreModule.length + 3)
        else {
            const d = sym.getDeclarations()?.[0]
            if (d && this.prelude.hasOwnProperty(d.getSourceFile().fileName)) {
                r = r.replace(/^global\./, "")
                if (
                    ts.isSourceFile(d.parent) ||
                    ts.isModuleBlock(d.parent) ||
                    (ts.isClassDeclaration(d.parent) &&
                        ts.isModuleBlock(d.parent.parent)) ||
                    (ts.isInterfaceDeclaration(d.parent) &&
                        ts.isSourceFile(d.parent.parent)) ||
                    (ts.isVariableDeclarationList(d.parent) &&
                        ts.isSourceFile(d.parent.parent.parent))
                ) {
                    if (["parseInt", "parseFloat"].indexOf(r) >= 0)
                        return "#ds." + r
                    return "#" + r
                }
                if (this.flags.traceBuiltin)
                    trace("not-builtin", SK[d.parent.kind], d.parent.kind, r)
                return r
            }
        }
        return r
    }

    private nodeName(node: ts.Node) {
        switch (node.kind) {
            case SK.NumberKeyword:
                return "#number"
            case SK.BooleanKeyword:
                return "#boolean"
        }
        return this.symName(this.getSymAtLocation(node))
    }

    private emitBuiltInCall(expr: CallLike, funName: string): Value {
        const wr = this.writer
        const obj = (expr.callexpr as ts.PropertyAccessExpression).expression
        switch (funName) {
            case "isNaN": {
                this.requireArgs(expr, 1)
                return wr.emitExpr(
                    Op.EXPR1_IS_NAN,
                    this.emitExpr(expr.arguments[0])
                )
            }
            case "ds.everyMs": {
                this.requireTopLevel(expr.position)
                this.requireArgs(expr, 2)
                const time = Math.round(
                    this.forceNumberLiteral(expr.arguments[0])
                )
                if (time < 20)
                    throwError(
                        expr.position,
                        "minimum everyMs() period is 20ms"
                    )
                const proc = this.emitHandler("every", expr.arguments[1], {
                    every: time,
                })
                proc.callMe(wr, [], OpCall.BG)
                return unit()
            }
            case "ds._onStart": {
                this.requireTopLevel(expr.position)
                this.requireArgs(expr, 1)
                const proc = this.emitHandler("onStart", expr.arguments[0])
                this.onStart.emit(wr => proc.callMe(wr, []))
                return unit()
            }
            case "console.log":
                wr.emitCall(
                    wr.dsMember(BuiltInString.LOG),
                    this.compileFormat(expr.arguments)
                )
                return unit()
            case "Date.now":
                return wr.emitExpr(Op.EXPR0_NOW_MS)

            case "Buffer.getAt": {
                this.requireArgs(expr, 2)
                const fmt = this.parseFormat(expr.arguments[1])
                return wr.emitExpr(
                    Op.EXPR3_LOAD_BUFFER,
                    this.emitExpr(obj),
                    literal(fmt),
                    this.emitExpr(expr.arguments[0])
                )
            }

            case "Buffer.setAt": {
                this.requireArgs(expr, 3)
                const fmt = this.parseFormat(expr.arguments[1])
                const off = this.emitExpr(expr.arguments[0])
                const val = this.emitExpr(expr.arguments[2])
                wr.emitStmt(
                    Op.STMT4_STORE_BUFFER,
                    this.emitExpr(obj),
                    literal(fmt),
                    off,
                    val
                )
                return unit()
            }

            case "ds._use": {
                this.requireArgs(expr, 1)
                this.ignore(this.emitExpr(expr.arguments[0]))
                return unit()
            }

            default:
                return null
        }
    }

    private emitCallExpression(expr: ts.CallExpression): Value {
        return this.emitCallLike({
            position: expr,
            callexpr: expr.expression,
            arguments: expr.arguments.slice(),
        })
    }

    private emitCallLike(call: CallLike): Value {
        const callName = this.nodeName(call.callexpr)
        const builtInName =
            callName && callName.startsWith("#") ? callName.slice(1) : null

        if (builtInName) {
            const builtIn = this.emitBuiltInCall(call, builtInName)
            if (builtIn) return builtIn
        }

        if (
            callName == "#Array.push" &&
            call.arguments.some(ts.isSpreadElement)
        ) {
            const lim = BinFmt.MAX_STACK_DEPTH - 1
            throwError(
                call.position,
                `...args has a length limit of ${lim} elements; better use Array.pushRange()`
            )
        }

        if (call.callexpr.kind == SK.SuperKeyword) {
            const wr = this.writer
            const baseCls = this.getSymAtLocation(call.callexpr)
            const baseDecl = symCell(baseCls) as FunctionDecl
            assert(baseDecl instanceof FunctionDecl)
            const bound = wr.emitExpr(
                Op.EXPR2_BIND,
                baseDecl.emit(wr),
                this.emitThisExpression(call.callexpr)
            )
            const r = this.emitGenericCall(call.arguments, bound)
            for (let node: ts.Node = call.callexpr; node; node = node.parent) {
                if (ts.isConstructorDeclaration(node)) {
                    this.emitCtorAssignments(node.parent, node)
                    return r
                }
            }
            assert(false)
        }

        const fn = call.compiledCallExpr ?? this.emitExpr(call.callexpr)
        return this.emitGenericCall(call.arguments, fn)
    }

    private getSymAtLocation(node: ts.Node) {
        let sym = this.checker.getSymbolAtLocation(node)
        if (!sym) {
            const decl = node as ts.NamedDeclaration
            if (decl.name) sym = this.checker.getSymbolAtLocation(decl.name)
        }
        return sym
    }

    private getCellAtLocation(node: ts.Node) {
        let sym: ts.Symbol
        if (node?.parent?.kind == SK.ShorthandPropertyAssignment)
            sym = this.checker.getShorthandAssignmentValueSymbol(node.parent)
        else sym = this.getSymAtLocation(node)
        return symCell(sym)
    }

    private getVarAtLocation(node: ts.Node) {
        const v = this.getCellAtLocation(node)
        if (!v) throwError(node, "variable not assigned yet")
        if (!(v instanceof Variable)) throwError(node, "expecting variable")
        return v
    }

    private getClosureLevel(variable: Variable) {
        if (variable.vkind == VariableKind.Global) return 0
        assert(!!variable.parentProc)
        let lev = 0
        let ptr = this.proc
        while (ptr && ptr != variable.parentProc) {
            lev++
            ptr = ptr.parentProc
        }
        assert(ptr != null)
        if (lev > 0) this.proc.usesClosure = true
        return lev
    }

    private emitIdentifier(expr: ts.Identifier): Value {
        const r = this.emitBuiltInConst(expr)
        if (r) return r
        const cell = this.getCellAtLocation(expr)
        if (!cell) throwError(expr, "unknown name: " + idName(expr))
        if (cell instanceof Variable) {
            const lev = this.getClosureLevel(cell)
            if (lev && this.isInLoop(cell.definition))
                throwError(
                    expr,
                    "closure references to loop variables are currently broken"
                )
            return cell.emitViaClosure(this.writer, lev)
        }
        return cell.emit(this.writer)
    }

    private emitThisExpression(expr: ts.Node): Value {
        const p0 = this.proc.params[0] as Variable
        if (p0 && p0.vkind == VariableKind.ThisParam)
            return p0.emit(this.writer)
        throwError(expr, "'this' cannot be used here: " + this.proc.name)
    }

    private emitElementAccessExpression(
        expr: ts.ElementAccessExpression
    ): Value {
        const val = this.emitExpr(expr.expression)
        const idx = this.emitExpr(expr.argumentExpression)
        return this.writer.emitExpr(Op.EXPR2_INDEX, val, idx)
    }

    private isRoleClass(sym: ts.Symbol) {
        if (
            !sym.valueDeclaration ||
            sym.valueDeclaration.kind != SK.ClassDeclaration
        )
            return false
        const tps = this.getBaseTypes(
            this.checker.getDeclaredTypeOfSymbol(sym)
        ).map(tp => this.symName(tp.getSymbol()))
        return tps.includes("#ds.Sensor") || tps.includes("#ds.Role")
    }

    private emitBuiltInConst(expr: ts.Expression) {
        const nodeName = this.nodeName(expr)
        if (!nodeName) return null
        switch (nodeName) {
            case "#NaN":
                return this.emitLiteral(NaN)
            case "#Infinity":
                return this.emitLiteral(Infinity)
            case "undefined":
                return this.emitLiteral(undefined)
            case "#ds_impl":
                return this.writer.emitBuiltInObject(BuiltInObject.DEVICESCRIPT)
            default:
                if (builtInObjByName.hasOwnProperty(nodeName))
                    return this.writer.emitBuiltInObject(
                        builtInObjByName[nodeName]
                    )
                if (this.flags.traceBuiltin) trace("traceBuiltin:", nodeName)
                if (nodeName.startsWith("#ds.")) {
                    const idx = BUILTIN_STRING__VAL.indexOf(nodeName.slice(4))
                    if (idx >= 0) {
                        this.markMethodUsed(nodeName)
                        return this.writer.dsMember(idx)
                    }
                }
                return null
        }
    }

    private emitPropertyAccessExpression(
        expr: ts.PropertyAccessExpression
    ): Value {
        const r = this.emitBuiltInConst(expr)
        if (r) return r

        const nsName = this.nodeName(expr.expression)
        if (nsName == "#Math") {
            const id = idName(expr.name)
            if (mathConst.hasOwnProperty(id)) return literal(mathConst[id])
        } else if (this.enums.hasOwnProperty(nsName)) {
            const e = this.enums[nsName]
            const prop = idName(expr.name)
            if (e.members.hasOwnProperty(prop)) return literal(e.members[prop])
            else throwError(expr, `enum ${nsName} has no member ${prop}`)
        }

        if (idName(expr.name) == "prototype") {
            const sym = this.checker.getSymbolAtLocation(expr.expression)
            if (this.isRoleClass(sym)) {
                const spec = this.specFromTypeName(expr.expression)
                const r = this.roles.find(r => r.spec == spec)
                if (r) {
                    r.used = true
                    return this.writer.emitExpr(
                        Op.EXPRx_ROLE_PROTO,
                        literal(r._index)
                    )
                } else {
                    if (!this.flags.allPrototypes)
                        throwError(expr, "role not used")
                }
            }
        }

        const { obj, idx } = this.tryEmitIndex(expr)
        return this.writer.emitIndex(obj, idx)
    }

    private isStringLiteral(node: ts.Node): node is ts.LiteralExpression {
        switch (node.kind) {
            case SK.TemplateHead:
            case SK.TemplateMiddle:
            case SK.TemplateTail:
            case SK.StringLiteral:
            case SK.NoSubstitutionTemplateLiteral:
                return true
            default:
                return false
        }
    }

    private emitLiteral(v: any, node?: ts.Node) {
        if (
            v === null ||
            v === undefined ||
            typeof v == "number" ||
            typeof v == "boolean"
        )
            return literal(v)

        if (typeof v == "string") return this.writer.emitString(v)

        throwError(node, "unhandled literal: " + v)
    }

    private emitLiteralExpression(node: ts.LiteralExpression): Value {
        const wr = this.writer

        if (node.kind == SK.NumericLiteral) {
            const parsed = parseFloat(node.text)
            return this.emitLiteral(parsed)
        } else if (this.isStringLiteral(node)) {
            return wr.emitString(node.text)
        } else {
            throwError(node, "whoops")
        }
    }

    private emitTemplateExpression(node: ts.TemplateExpression): Value {
        return this.compileFormat([node])
    }

    private isInterfaceType(tp: ts.Type): tp is ts.InterfaceType {
        return !!(
            tp.getFlags() & ts.TypeFlags.Object &&
            (tp as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface
        )
    }

    private getBaseTypes(clsTp: ts.Type) {
        if (this.isInterfaceType(clsTp)) return this.checker.getBaseTypes(clsTp)
        return []
    }

    private getBaseSyms(sym: ts.Symbol) {
        const res: ts.Symbol[] = []
        const decl = sym?.valueDeclaration
        if (!decl) return res

        const cls = this.getSymAtLocation(decl.parent)
        if (!cls) return []
        const clsTp = this.checker.getDeclaredTypeOfSymbol(cls)
        for (const baseTp of this.getBaseTypes(clsTp)) {
            const baseSym = this.checker.getPropertyOfType(
                baseTp,
                sym.getName()
            )
            if (baseSym) res.push(baseSym, ...this.getBaseSyms(baseSym))
        }

        return res
    }

    private emitPrototypeUpdate(expr: ts.BinaryExpression): Value {
        const left = expr.left

        if (!ts.isPropertyAccessExpression(left)) return null
        if (!ts.isFunctionExpression(expr.right)) return null
        if (!this.isTopLevel(expr.parent)) return null

        const sym = this.getSymAtLocation(left)
        const decl = sym?.valueDeclaration

        if (decl) {
            this.protoDefinitions.push({
                methodName: idName(left.name),
                className: this.nodeName(decl.parent),
                names: this.methodNames(sym),
                protoUpdate: expr,
            })
            return unit()
        } else {
            throwError(expr, "can't determine symbol of prototype update")
        }
    }

    private emitAssignmentTarget(trg: Expr) {
        const wr = this.writer
        const r = this.tryEmitIndex(trg)
        if (r) {
            const obj = wr.cacheValue(r.obj)
            const idx = wr.cacheValue(r.idx)

            return {
                read: () => wr.emitIndex(obj.emit(), idx.emit()),
                write: (src: Value) =>
                    wr.emitStmt(
                        Op.STMT3_INDEX_SET,
                        obj.emit(),
                        idx.emit(),
                        src
                    ),
                free: () => {
                    obj.free()
                    idx.free()
                },
            }
        }

        if (ts.isIdentifier(trg)) {
            const variable = this.getVarAtLocation(trg)
            return {
                read: () => variable.emit(wr),
                write: (src: Value) => this.emitStore(variable, src),
                free: () => {},
            }
        }

        throwError(trg, "unsupported assignment target")
    }

    private emitAssignmentExpression(
        expr: ts.BinaryExpression,
        noProto = false
    ): Value {
        this.forceAssignmentIgnored(expr)

        const res = noProto ? null : this.emitPrototypeUpdate(expr)
        if (res) return res

        const wr = this.writer
        let left = expr.left

        const r = this.tryEmitIndex(left)
        if (r) {
            const src = this.emitExpr(expr.right) // compute src after left.property
            wr.emitStmt(Op.STMT3_INDEX_SET, r.obj, r.idx, src)
            return unit()
        }

        const src = this.emitExpr(expr.right)
        if (ts.isArrayLiteralExpression(left)) {
            throwError(expr, "todo array assignment")
        } else if (ts.isIdentifier(left)) {
            const v = this.getVarAtLocation(left)
            this.emitStore(v, src)
            return unit()
        }

        throwError(expr, "unhandled assignment")
    }

    private forceAssignmentIgnored(expr: Expr) {
        if (!this.isIgnored(expr))
            throwError(
                expr,
                "the value of assignment expression has to be ignored"
            )
    }

    private emitBinaryExpression(expr: ts.BinaryExpression): Value {
        const simpleOps: SMap<Op> = {
            [SK.PlusToken]: Op.EXPR2_ADD,
            [SK.MinusToken]: Op.EXPR2_SUB,
            [SK.SlashToken]: Op.EXPR2_DIV,
            [SK.AsteriskToken]: Op.EXPR2_MUL,
            [SK.LessThanToken]: Op.EXPR2_LT,
            [SK.BarToken]: Op.EXPR2_BIT_OR,
            [SK.AmpersandToken]: Op.EXPR2_BIT_AND,
            [SK.CaretToken]: Op.EXPR2_BIT_XOR,
            [SK.LessThanLessThanToken]: Op.EXPR2_SHIFT_LEFT,
            [SK.GreaterThanGreaterThanToken]: Op.EXPR2_SHIFT_RIGHT,
            [SK.GreaterThanGreaterThanGreaterThanToken]:
                Op.EXPR2_SHIFT_RIGHT_UNSIGNED,
            [SK.LessThanEqualsToken]: Op.EXPR2_LE,
            [SK.EqualsEqualsToken]: Op.EXPR2_EQ,
            [SK.EqualsEqualsEqualsToken]: Op.EXPR2_EQ,
            [SK.ExclamationEqualsToken]: Op.EXPR2_NE,
            [SK.ExclamationEqualsEqualsToken]: Op.EXPR2_NE,
            [SK.InstanceOfKeyword]: Op.EXPR2_INSTANCE_OF,
        }

        function stripEquals(k: SK) {
            switch (k) {
                case SK.PlusEqualsToken:
                    return SK.PlusToken
                case SK.MinusEqualsToken:
                    return SK.MinusToken
                case SK.AsteriskEqualsToken:
                    return SK.AsteriskToken
                case SK.AsteriskAsteriskEqualsToken:
                    return SK.AsteriskAsteriskToken
                case SK.SlashEqualsToken:
                    return SK.SlashToken
                case SK.PercentEqualsToken:
                    return SK.PercentToken
                case SK.LessThanLessThanEqualsToken:
                    return SK.LessThanLessThanToken
                case SK.GreaterThanGreaterThanEqualsToken:
                    return SK.GreaterThanGreaterThanToken
                case SK.GreaterThanGreaterThanGreaterThanEqualsToken:
                    return SK.GreaterThanGreaterThanGreaterThanToken
                case SK.AmpersandEqualsToken:
                    return SK.AmpersandToken
                case SK.BarEqualsToken:
                    return SK.BarToken
                case SK.CaretEqualsToken:
                    return SK.CaretToken
                default:
                    return null
            }
        }

        let op = expr.operatorToken.kind

        if (op == SK.EqualsToken) return this.emitAssignmentExpression(expr)

        if (op == SK.CommaToken) {
            this.ignore(this.emitExpr(expr.left))
            return this.emitExpr(expr.right)
        }

        let swap = false
        if (op == SK.GreaterThanToken) {
            op = SK.LessThanToken
            swap = true
        }
        if (op == SK.GreaterThanEqualsToken) {
            op = SK.LessThanEqualsToken
            swap = true
        }

        const wr = this.writer

        if (op == SK.AmpersandAmpersandToken || op == SK.BarBarToken) {
            const a = this.emitExpr(expr.left)
            const tmp = wr.cacheValue(a, true)
            const tst = wr.emitExpr(
                op == SK.AmpersandAmpersandToken
                    ? Op.EXPR1_TO_BOOL
                    : Op.EXPR1_NOT,
                tmp.emit()
            )
            const skipB = wr.mkLabel("lazyB")
            wr.emitJumpIfFalse(skipB, tst)
            tmp.store(this.emitExpr(expr.right))
            wr.emitLabel(skipB)

            return tmp.finalEmit()
        }

        const emitBin = (op: SK, a: Value, b: Value) => {
            if (op == SK.AsteriskAsteriskToken)
                return this.emitMathCall(BuiltInString.POW, a, b)
            if (op == SK.PercentToken)
                return this.emitMathCall(BuiltInString.IMOD, a, b)

            const op2 = simpleOps[op]
            if (op2 === undefined) throwError(expr, "unhandled operator")

            const res = wr.emitExpr(op2, a, b)
            return res
        }

        if (stripEquals(op) != null) {
            op = stripEquals(op)
            const t = this.emitAssignmentTarget(expr.left)
            const other = this.emitExpr(expr.right)
            this.forceAssignmentIgnored(expr)
            const r = emitBin(op, t.read(), other)
            t.write(r)
            t.free()
            return unit()
        }

        let a = this.emitExpr(expr.left)
        let b = this.emitExpr(expr.right)
        if (swap) [a, b] = [b, a]

        return emitBin(op, a, b)
    }

    private mapPostfixOp(k: SK) {
        if (k == SK.PlusPlusToken) return Op.EXPR2_ADD
        if (k == SK.MinusMinusToken) return Op.EXPR2_SUB
        return null
    }

    private emitUnaryExpression(expr: ts.PrefixUnaryExpression): Value {
        const wr = this.writer
        const simpleOps: SMap<Op> = {
            [SK.ExclamationToken]: Op.EXPR1_NOT,
            [SK.MinusToken]: Op.EXPR1_NEG,
            [SK.PlusToken]: Op.EXPR1_UPLUS,
            [SK.TildeToken]: Op.EXPR1_BIT_NOT,
        }

        let arg = expr.operand

        const updateOp = this.mapPostfixOp(expr.operator)
        if (updateOp) {
            const t = this.emitAssignmentTarget(expr.operand)
            t.write(wr.emitExpr(updateOp, t.read(), literal(1)))
            const r = t.read()
            t.free()
            return r
        }

        let op = simpleOps[expr.operator]
        if (op === undefined) throwError(expr, "unhandled operator")

        if (
            expr.operator == SK.ExclamationToken &&
            ts.isPrefixUnaryExpression(arg) &&
            arg.operator == SK.ExclamationToken
        ) {
            op = Op.EXPR1_TO_BOOL
            arg = arg.operand
        }

        return wr.emitExpr(op, this.emitExpr(arg))
    }

    private emitArrayExpression(expr: ts.ArrayLiteralExpression): Value {
        const wr = this.writer
        const sz = expr.elements.length
        wr.emitStmt(Op.STMT1_ALLOC_ARRAY, literal(sz))
        const arr = wr.emitExpr(Op.EXPR0_RET_VAL)
        if (sz == 0) return arr
        const ref = wr.cacheValue(arr)
        for (let i = 0; i < sz; ++i) {
            wr.emitStmt(
                Op.STMT3_INDEX_SET,
                ref.emit(),
                literal(i),
                this.emitExpr(expr.elements[i])
            )
        }
        return ref.finalEmit()
    }

    private markMethodUsed(meth: string) {
        assert(!!meth)
        if (!this.usedMethods[meth]) {
            if (this.flags.traceProto) trace(`use: ${meth}`)
            this.usedMethods[meth] = true
        }
    }

    private tryEmitIndex(expr: Expr) {
        const wr = this.writer
        if (
            ts.isElementAccessExpression(expr) ||
            ts.isPropertyAccessExpression(expr)
        ) {
            const obj = this.emitExpr(expr.expression)
            let idx: Value
            if (ts.isPropertyAccessExpression(expr)) {
                idx = wr.emitString(this.forceName(expr.name))
                const sym = this.getSymAtLocation(expr)
                const decl = sym?.valueDeclaration
                const symName = this.symName(sym)
                if (
                    (symName && symName[0] == "#") ||
                    (decl && decl.parent && ts.isClassLike(decl.parent))
                ) {
                    this.markMethodUsed(symName)
                } else {
                    this.markMethodUsed("*" + idName(expr.name))
                }
            } else {
                idx = this.emitExpr(expr.argumentExpression)
                if (idx.strValue != undefined)
                    this.markMethodUsed("*" + idx.strValue)
            }
            return { obj, idx }
        }
        return null
    }

    private emitDeleteExpression(expr: ts.DeleteExpression): Value {
        const wr = this.writer
        const r = this.tryEmitIndex(expr.expression)
        if (!r) throwError(expr, "unsupported delete")
        wr.emitStmt(Op.STMT2_INDEX_DELETE, r.obj, r.idx)
        return this.retVal()
    }

    private emitNewExpression(expr: ts.NewExpression): Value {
        const wr = this.writer
        const desc: CallLike = {
            position: expr,
            callexpr: expr.expression,
            arguments: expr.arguments ? expr.arguments.slice() : [],
        }
        desc.compiledCallExpr = wr.emitExpr(
            Op.EXPR1_NEW,
            this.emitExpr(desc.callexpr)
        )
        return this.emitCallLike(desc)
    }

    private emitPostfixUnaryExpression(expr: ts.PostfixUnaryExpression): Value {
        const wr = this.writer
        const t = this.emitAssignmentTarget(expr.operand)
        const op = this.mapPostfixOp(expr.operator)
        assert(op != null)
        if (this.isIgnored(expr)) {
            t.write(wr.emitExpr(op, t.read(), literal(1)))
            t.free()
            return unit()
        } else {
            const cached = wr.cacheValue(t.read())
            assert(cached.isCached)
            t.write(wr.emitExpr(op, cached.emit(), literal(1)))
            t.free()
            return cached.finalEmit()
        }
    }

    private emitConditionalExpression(expr: ts.ConditionalExpression): Value {
        const wr = this.writer
        const cond = this.emitExpr(expr.condition)
        if (this.valueIsAlwaysFalse(cond)) {
            return this.emitExpr(expr.whenFalse)
        } else if (this.valueIsAlwaysTrue(cond)) {
            return this.emitExpr(expr.whenTrue)
        } else {
            const lblElse = wr.mkLabel("condElse")
            const lblEnd = wr.mkLabel("condEnd")
            wr.emitJumpIfFalse(lblElse, cond)
            const tmp = wr.cacheValue(this.emitExpr(expr.whenTrue), true)
            wr.emitJump(lblEnd)
            wr.emitLabel(lblElse)
            tmp.store(this.emitExpr(expr.whenFalse))
            wr.emitLabel(lblEnd)
            return tmp.finalEmit()
        }
    }

    private isAssignment(expr: ts.Node): expr is ts.BinaryExpression {
        return (
            expr &&
            ts.isBinaryExpression(expr) &&
            expr.operatorToken.kind == SK.EqualsToken
        )
    }

    private isProtoRef(expr: ts.Node) {
        return (
            expr &&
            ts.isPropertyAccessExpression(expr) &&
            idName(expr.name) == "prototype"
        )
    }

    private emitFunctionExpr(expr: FunctionLike): Value {
        const wr = this.writer
        let n = expr.name ? idName(expr.name) : null
        let isMethod = false

        if (this.isAssignment(expr.parent)) {
            if (ts.isPropertyAccessExpression(expr.parent.left)) {
                const methName = expr.parent.left.name
                if (this.isProtoRef(expr.parent.left.expression))
                    isMethod = true
                if (!n) n = idName(methName)
            }
        }
        if (!n) n = "inline"

        const proc = new Procedure(this, n, expr, isMethod)
        this.proc.addNestedProc(proc)

        // this is conservative
        if (this.proc.parentProc) this.proc.usesClosure = true

        return proc.referenceAsClosure(wr)
    }

    private emitObjectExpression(expr: ts.ObjectLiteralExpression): Value {
        const wr = this.writer
        wr.emitStmt(Op.STMT0_ALLOC_MAP)
        const ret = this.retVal()
        if (expr.properties.length == 0) return ret

        const arr = wr.cacheValue(ret)
        for (const p of expr.properties) {
            let expr: Expr
            if (ts.isPropertyAssignment(p)) {
                expr = p.initializer
            } else if (
                ts.isShorthandPropertyAssignment(p) &&
                !p.objectAssignmentInitializer
            ) {
                expr = p.name
            } else if (ts.isSpreadAssignment(p) && !p.name) {
                wr.emitCall(
                    wr.objectMember(BuiltInString.ASSIGN),
                    arr.emit(),
                    this.emitExpr(p.expression)
                )
                continue
            } else {
                throwError(p, `unsupported initializer ${SK[p.kind]}`)
            }
            let fld: Value
            if (ts.isComputedPropertyName(p.name)) {
                fld = this.emitExpr(p.name.expression)
            } else if (
                ts.isNumericLiteral(p.name) ||
                ts.isStringLiteral(p.name)
            ) {
                fld = this.emitExpr(p.name)
            } else {
                fld = wr.emitString(this.forceName(p.name))
            }
            const init = this.emitExpr(expr)
            wr.emitStmt(Op.STMT3_INDEX_SET, arr.emit(), fld, init)
        }

        return arr.finalEmit()
    }

    private emitExpr(expr: Expr): Value {
        switch (expr.kind) {
            case SK.AsExpression:
                return this.emitExpr((expr as ts.AsExpression).expression)
            case SK.TypeAssertionExpression:
                return this.emitExpr((expr as ts.TypeAssertion).expression)
            case SK.CallExpression:
                return this.emitCallExpression(expr as ts.CallExpression)
            case SK.FalseKeyword:
                return this.emitLiteral(false)
            case SK.TrueKeyword:
                return this.emitLiteral(true)
            case SK.NullKeyword:
                return this.emitLiteral(null)
            case SK.UndefinedKeyword:
                return this.emitLiteral(undefined)
            case SK.Identifier:
                return this.emitIdentifier(expr as ts.Identifier)
            case SK.ThisKeyword:
                return this.emitThisExpression(expr as ts.ThisExpression)
            case SK.ElementAccessExpression:
                return this.emitElementAccessExpression(
                    expr as ts.ElementAccessExpression
                )
            case SK.PropertyAccessExpression:
                return this.emitPropertyAccessExpression(
                    expr as ts.PropertyAccessExpression
                )

            case SK.TemplateHead:
            case SK.TemplateMiddle:
            case SK.TemplateTail:
            case SK.NumericLiteral:
            case SK.StringLiteral:
            case SK.NoSubstitutionTemplateLiteral:
                //case SyntaxKind.RegularExpressionLiteral:
                return this.emitLiteralExpression(expr as ts.LiteralExpression)

            case SK.TemplateExpression:
                return this.emitTemplateExpression(
                    expr as ts.TemplateExpression
                )

            case SK.BinaryExpression:
                return this.emitBinaryExpression(expr as ts.BinaryExpression)
            case SK.PrefixUnaryExpression:
                return this.emitUnaryExpression(
                    expr as ts.PrefixUnaryExpression
                )
            case SK.TaggedTemplateExpression:
                return this.emitStringOrBuffer(
                    expr as ts.TaggedTemplateExpression
                )
            case SK.ArrayLiteralExpression:
                return this.emitArrayExpression(
                    expr as ts.ArrayLiteralExpression
                )
            case SK.ObjectLiteralExpression:
                return this.emitObjectExpression(
                    expr as ts.ObjectLiteralExpression
                )
            case SK.ParenthesizedExpression:
                return this.emitExpr(
                    (expr as ts.ParenthesizedExpression).expression
                )
            case SK.ArrowFunction:
                return this.emitFunctionExpr(expr as ts.ArrowFunction)
            case SK.FunctionExpression:
                return this.emitFunctionExpr(expr as ts.FunctionExpression)
            case SK.DeleteExpression:
                return this.emitDeleteExpression(expr as ts.DeleteExpression)
            case SK.NewExpression:
                return this.emitNewExpression(expr as ts.NewExpression)
            case SK.TypeOfExpression:
                return this.writer.emitExpr(
                    Op.EXPR1_TYPEOF_STR,
                    this.emitExpr((expr as ts.TypeOfExpression).expression)
                )
            case SK.PostfixUnaryExpression:
                return this.emitPostfixUnaryExpression(
                    expr as ts.PostfixUnaryExpression
                )
            case SK.ConditionalExpression:
                return this.emitConditionalExpression(
                    expr as ts.ConditionalExpression
                )
            default:
                // console.log(expr)
                return throwError(expr, "unhandled expr: " + SK[expr.kind])
        }
    }

    private sourceFrag(node: ts.Node) {
        const text = node.getFullText().trim()
        return text.slice(0, 60).replace(/\n[^]*/, "...")
    }

    private handleException(stmt: ts.Node, e: any) {
        if (e.terminateEmit) throw e

        if (!stmt) stmt = this.lastNode

        if (e.sourceNode !== undefined) {
            const node = e.sourceNode || stmt
            this.reportError(node, e.message)
            // console.log(e.stack)
        } else {
            debugger
            this.reportError(stmt, "Internal error: " + e.message)
            console.error(e.stack)
            e.terminateEmit = true
            throw e
        }
    }

    private emitStmt(stmt: ts.Statement) {
        const src = this.sourceFrag(stmt)
        const wr = this.writer

        this.lastNode = stmt

        this.assignCellsToStmt(stmt)

        wr.locPush(this.getSrcLocation(stmt))

        try {
            switch (stmt.kind) {
                case SK.ExpressionStatement:
                    return this.emitExpressionStatement(
                        stmt as ts.ExpressionStatement
                    )
                case SK.VariableStatement:
                    return this.emitVariableStatement(
                        stmt as ts.VariableStatement
                    )
                case SK.IfStatement:
                    return this.emitIfStatement(stmt as ts.IfStatement)
                case SK.WhileStatement:
                    return this.emitWhileStatement(stmt as ts.WhileStatement)
                case SK.ForStatement:
                    return this.emitForStatement(stmt as ts.ForStatement)
                case SK.ForOfStatement:
                    return this.emitForOfStatement(stmt as ts.ForOfStatement)
                case SK.ContinueStatement:
                case SK.BreakStatement:
                    return this.emitBreakContStatement(
                        stmt as ts.BreakOrContinueStatement
                    )
                case SK.Block:
                    return this.emitBlock(stmt as ts.Block)
                case SK.TryStatement:
                    return this.emitTryStatement(stmt as ts.TryStatement)
                case SK.ThrowStatement:
                    return this.emitThrowStatement(stmt as ts.ThrowStatement)
                case SK.ReturnStatement:
                    return this.emitReturnStatement(stmt as ts.ReturnStatement)
                case SK.FunctionDeclaration:
                    return this.emitFunctionDeclaration(
                        stmt as ts.FunctionDeclaration
                    )
                case SK.ClassDeclaration:
                    return this.emitClassDeclaration(
                        stmt as ts.ClassDeclaration
                    )
                case SK.DebuggerStatement:
                    return this.writer.emitStmt(Op.STMT0_DEBUGGER)
                case SK.TypeAliasDeclaration:
                case SK.ExportDeclaration:
                case SK.InterfaceDeclaration:
                case SK.ModuleDeclaration:
                case SK.EmptyStatement:
                    return // ignore
                case SK.ImportDeclaration:
                    return // ignore
                default:
                    // console.log(stmt)
                    throwError(stmt, `unhandled stmt type: ${SK[stmt.kind]}`)
            }
        } catch (e) {
            this.handleException(stmt, e)
        } finally {
            wr.stmtEnd()
            wr.locPop()
        }
    }

    private assertLittleEndian() {
        const test = new Uint16Array([0xd042])
        assert(toHex(new Uint8Array(test.buffer)) == "42d0")
    }

    private specialFieldFmt(f: jdspec.PacketMember) {
        switch (f.type) {
            case "string":
                return NumFmtSpecial.STRING
            case "bool":
                return NumFmtSpecial.BOOL
            case "string0":
                return NumFmtSpecial.STRING0
            case "bytes":
                return NumFmtSpecial.BYTES
            case "pipe":
                return NumFmtSpecial.PIPE
            case "pipe_port":
                return NumFmtSpecial.PIPE_PORT
            default:
                return undefined
        }
    }

    private fieldFmt(f: jdspec.PacketMember) {
        const special = f ? this.specialFieldFmt(f) : NumFmtSpecial.EMPTY
        if (special != undefined) {
            return (
                NumFmt.SPECIAL | ((special & 0xf) << 4) | ((special >> 4) & 0x3)
            )
        } else {
            return bufferFmt(f)
        }
    }

    private serializeStartServices() {
        const cfg = jsonToDcfg({
            _: new Array(0x40).concat(this.startServices),
        })
        const bin = serializeDcfg(cfg)
        const writer = new SectionWriter()
        if (this.startServices.length) {
            writer.append(bin)
            writer.align()
        }
        return writer
    }

    private serializeSpecs() {
        let usedSpecs = uniqueMap(
            this.roles,
            r => r.spec.classIdentifier + "",
            r => r.spec
        )
        if (false)
            usedSpecs = Object.values(this.serviceSpecs).filter(
                s => s.shortId[0] != "_"
            )
        if (usedSpecs.length) {
            usedSpecs.unshift(this.serviceSpecs["sensor"])
            usedSpecs.unshift(this.serviceSpecs["base"])
        }
        const numSpecs = usedSpecs.length
        const specWriter = new SectionWriter()

        const later = usedSpecs.map(spec => {
            const specDesc = new Uint8Array(BinFmt.SERVICE_SPEC_HEADER_SIZE)
            specWriter.append(specDesc)
            let flags = 0

            if (spec.extends.indexOf("_sensor") >= 0)
                flags |= ServiceSpecFlag.DERIVE_SENSOR

            const name = upperCamel(spec.camelName)
            write16(specDesc, 0, this.addString(name))
            write32(specDesc, 4, spec.classIdentifier)
            write16(specDesc, 2, flags)
            const pkts = spec.packets

            return () => {
                const multifields = pkts.map(pkt => {
                    if (
                        pkt.fields.length == 0 ||
                        (pkt.fields.length == 1 && !pkt.fields[0].startRepeats)
                    )
                        return -1 // inline field
                    else {
                        const r = specWriter.currSize >> 2
                        for (const f of pkt.fields) {
                            let flags = 0x00
                            let numfmt = 0
                            if (f.storage && /u8\[/.test(f.type)) {
                                flags |= FieldSpecFlag.IS_BYTES
                                numfmt = f.storage
                            } else {
                                numfmt = this.fieldFmt(f)
                            }
                            if (f.startRepeats)
                                flags |= FieldSpecFlag.STARTS_REPEATS
                            specWriter.append(
                                encodeU16LE([
                                    this.addString(camelize(f.name)),
                                    numfmt | (flags << 8),
                                ])
                            )
                        }
                        specWriter.append(encodeU16LE([0, 0]))
                        assert(4 == BinFmt.SERVICE_SPEC_FIELD_SIZE)
                        return r
                    }
                })
                const startoff = specWriter.currSize
                let idx = -1
                for (const pkt of pkts) {
                    idx++
                    let code = pkt.identifier
                    let flags = 0
                    if (pkt.derived) continue
                    if (isRegister(pkt)) code |= PacketSpecCode.REGISTER
                    else if (pkt.kind == "event") code |= PacketSpecCode.EVENT
                    else if (pkt.kind == "command")
                        code |= PacketSpecCode.COMMAND
                    else if (pkt.kind == "report") code |= PacketSpecCode.REPORT
                    else if (pkt.kind.includes("pipe")) continue
                    else oops(`unknown pkt kind ${pkt.kind}`)
                    let numfmt = multifields[idx]
                    if (numfmt == -1) numfmt = this.fieldFmt(pkt.fields[0])
                    else flags |= PacketSpecFlag.MULTI_FIELD
                    const pktDesc = encodeU16LE([
                        this.addString(camelize(pkt.name)),
                        code,
                        flags,
                        numfmt,
                    ])
                    assert(
                        pktDesc.length == BinFmt.SERVICE_SPEC_PACKET_SIZE,
                        "sz"
                    )
                    specWriter.append(pktDesc)
                }

                write16(specDesc, 10, startoff >> 2)
                const nument =
                    (specWriter.currSize - startoff) /
                    BinFmt.SERVICE_SPEC_PACKET_SIZE
                write16(specDesc, 8, nument)
            }
        })

        later.forEach(f => f())

        specWriter.align()

        return {
            numSpecs,
            specWriter,
        }

        function isRegister(pi: jdspec.PacketInfo) {
            return pi.kind == "ro" || pi.kind == "rw" || pi.kind == "const"
        }
    }

    private serialize() {
        // serialization only works on little endian machines
        this.assertLittleEndian()

        const fixHeader = new SectionWriter(BinFmt.FIX_HEADER_SIZE)
        const sectDescs = new SectionWriter()
        const sections: SectionWriter[] = [fixHeader, sectDescs]

        const hd = new Uint8Array(BinFmt.FIX_HEADER_SIZE)
        hd.set(
            encodeU32LE([
                BinFmt.MAGIC0,
                BinFmt.MAGIC1,
                BinFmt.IMG_VERSION,
                this.globals.length,
            ])
        )
        fixHeader.append(hd)

        const funDesc = new SectionWriter()
        const funData = new SectionWriter()
        const floatData = new SectionWriter()
        const roleData = new SectionWriter()
        const asciiDesc = new SectionWriter()
        const utf8Desc = new SectionWriter()
        const bufferDesc = new SectionWriter()
        const strData = new SectionWriter()
        const { specWriter, numSpecs } = this.serializeSpecs()
        const dcfgWriter = this.serializeStartServices()
        write16(hd, 14, numSpecs)

        const writers = [
            funDesc,
            funData,
            floatData,
            roleData,
            asciiDesc,
            utf8Desc,
            bufferDesc,
            strData,
            specWriter,
            dcfgWriter,
        ]

        assert(BinFmt.NUM_IMG_SECTIONS == writers.length)

        for (const s of writers) {
            sectDescs.append(s.desc)
            sections.push(s)
        }

        funDesc.size = BinFmt.FUNCTION_HEADER_SIZE * this.procs.length

        for (const proc of this.procs) {
            funDesc.append(proc.writer.desc)
            proc.writer.offsetInFuncs = funData.currSize
            funData.append(proc.writer.serialize())
        }

        const floatBuf = new Float64Array(this.floatLiterals).buffer
        const nanboxedU32 = new Uint32Array(floatBuf)
        for (let i = 0; i < this.floatLiterals.length; ++i) {
            const f = this.floatLiterals[i]
            if ((f | 0) == f) {
                nanboxedU32[i * 2] = f
                nanboxedU32[i * 2 + 1] = -1
            }
        }
        floatData.append(new Uint8Array(floatBuf))

        for (const r of this.roles) {
            roleData.append(r.serialize())
        }

        function addLits(lst: (Uint8Array | string)[], dst: SectionWriter) {
            lst.forEach(str => {
                const buf: Uint8Array =
                    typeof str == "string"
                        ? stringToUint8Array(toUTF8(str) + "\u0000")
                        : str

                let desc = new Uint8Array(BinFmt.SECTION_HEADER_SIZE)
                write32(desc, 0, strData.currSize)
                write32(
                    desc,
                    4,
                    typeof str == "string" ? buf.length - 1 : buf.length
                )
                strData.append(buf)
                if (dst == asciiDesc) {
                    assert(desc[2] == 0)
                    assert(desc[3] == 0)
                    desc = desc.slice(0, BinFmt.ASCII_HEADER_SIZE)
                }
                dst.append(desc)
                return desc
            })
        }

        addLits(this.asciiLiterals, asciiDesc)
        addLits(this.utf8Literals, utf8Desc)
        addLits(this.bufferLiterals, bufferDesc)

        asciiDesc.align()

        strData.append(new Uint8Array(1)) // final NUL-terminator
        strData.align()

        let off = 0
        for (const s of sections) {
            s.finalize(off)
            off += s.size
        }

        const mask = BinFmt.BINARY_SIZE_ALIGN - 1
        off = (off + mask) & ~mask
        const outp = new Uint8Array(off)

        for (const proc of this.procs) {
            proc.writer.finalizeDesc(funData.offset + proc.writer.offsetInFuncs)
        }

        off = 0
        for (const s of sections) {
            for (const d of s.data) {
                outp.set(d, off)
                off += d.length
            }
        }

        const left = outp.length - off
        assert(0 <= left && left < BinFmt.BINARY_SIZE_ALIGN)

        const srcmap = arrayConcatMany(this.procs.map(p => p.writer.srcmap))
        let prevPC = 0
        let prevPos = 0
        for (let i = 0; i < srcmap.length; i += srcMapEntrySize) {
            const pos = srcmap[i]
            const pc = srcmap[i + 2]
            srcmap[i] = pos - prevPos
            srcmap[i + 2] = pc - prevPC
            prevPC = pc
            prevPos = pos
        }

        const dbg: DebugInfo = {
            sizes: {
                header: fixHeader.size + sectDescs.size,
                floats: floatData.size,
                strings:
                    strData.size +
                    asciiDesc.size +
                    utf8Desc.size +
                    bufferDesc.size,
                roles: roleData.size,
                align: left,
            },
            roles: this.roles.map(r => r.debugInfo()),
            functions: this.procs.map(p => p.debugInfo()),
            globals: this.globals.map(r => r.debugInfo()),
            srcmap,
            sources: this.srcFiles.slice(),
            binary: { hex: toHex(outp) },
        }

        return { binary: outp, dbg }
    }

    getAssembly() {
        return this.procs.map(p => p.toString()).join("\n")
    }

    inMainFile(node: ts.Node) {
        return node.getSourceFile() == this.mainFile
    }

    private emitLibrary() {
        if (!this.isLibrary) return

        const q = (b: string | Uint8Array) => {
            if (typeof b == "string") return "s:" + b
            else return "h:" + toHex(b)
        }
        const cleanDesc = (desc: Uint8Array) => {
            // clear offset since it's meaningless in library
            desc = new Uint8Array(desc)
            write32(desc, 0, 0)
            return desc
        }
        const lib = {
            procs: this.procs.map(p => ({
                name: p.name,
                desc: q(cleanDesc(p.writer.desc)),
                body: q(p.writer.serialize()),
            })),
            buffer: this.bufferLiterals.map(q),
            ascii: this.asciiLiterals.map(q),
            utf8: this.utf8Literals.map(q),
            floats: this.floatLiterals.slice(),
        }
        this.host.write(DEVS_LIB_FILE, JSON.stringify(lib, null, 1))
    }

    emit(): CompilationResult {
        assert(!this.tree)

        this.tree = buildAST(this.host, this._source, this.prelude)
        this.checker = this.tree.getTypeChecker()

        getProgramDiagnostics(this.tree).forEach(d => this.printDiag(d))

        const files = this.tree.getSourceFiles()
        this.mainFile = files[files.length - 1]

        this.emitProgram(this.tree)

        for (const p of this.procs) {
            // all procs should be finalized by here
            if (!p.mapVarOffset) oops(`proc ${p.name} not finalized`)
        }

        const staticProcs: Record<string, boolean> = {}
        for (const p of this.procs) {
            if (!p.usesClosure) staticProcs[p.index + ""] = true
        }
        const funIsStatic = (idx: number) => staticProcs[idx + ""] == true
        for (const p of this.procs) {
            p.writer.makeFunctionsStatic(funIsStatic)
        }

        const { binary, dbg } = this.serialize()
        const progJson = {
            text: this._source,
            blocks: "",
            compiled: toHex(binary),
        }
        this.host.write(DEVS_BODY_FILE, JSON.stringify(progJson, null, 4))
        this.host.write(DEVS_DBG_FILE, JSON.stringify(dbg))
        this.host.write(DEVS_SIZES_FILE, computeSizes(dbg))

        // this file is tracked by --watch and should be written last
        this.host.write(DEVS_BYTECODE_FILE, binary)

        if (this.numErrors == 0) {
            try {
                this.host?.verifyBytecode(binary, dbg)
            } catch (e) {
                this.reportError(this.mainFile, e.message)
            }
        }

        if (this.numErrors == 0) this.emitLibrary()

        return {
            success: this.numErrors == 0,
            binary: binary,
            dbg: dbg,
            diagnostics: this.diagnostics,
        }
    }
}

export interface CompilationResult {
    success: boolean
    binary: Uint8Array
    dbg: DebugInfo
    diagnostics: DevsDiagnostic[]
}

export function sanitizeDiagnostic(d: DevsDiagnostic): DevsDiagnostic {
    return {
        ...related(d),
        filename: d.filename,
        line: d.line,
        column: d.column,
        endLine: d.endLine,
        endColumn: d.endColumn,
        formatted: d.formatted,
        relatedInformation: d.relatedInformation?.map(related),
    }

    function related(
        d: ts.DiagnosticRelatedInformation
    ): ts.DiagnosticRelatedInformation & { filename: string } {
        return {
            category: d.category,
            code: d.code,
            file: undefined,
            filename: d.file?.fileName,
            start: d.start,
            length: d.length,
            messageText: d.messageText,
        }
    }
}

/**
 * Compiles the DeviceScript program.
 * @param code
 * @param opts
 * @returns
 */
export function compile(
    code: string,
    opts: {
        host?: Host
        mainFileName?: string
        log?: (msg: string) => void
        files?: Record<string, string | Uint8Array>
        errors?: DevsDiagnostic[]
        specs?: jdspec.ServiceSpec[]
        verifyBytecode?: (buf: Uint8Array) => void
        flags?: CompileFlags
    } = {}
): CompilationResult {
    const {
        files = {},
        mainFileName = "",
        specs = jacdacDefaultSpecifications,
        log = (msg: string) => console.debug(msg),
        verifyBytecode = () => {},
        errors = [],
    } = opts
    const {
        host = <Host>{
            mainFileName: () => mainFileName,
            write: (filename: string, contents: string | Uint8Array) => {
                files[filename] = contents
            },
            log,
            error: err => errors.push(err),
            getSpecs: () => specs,
            verifyBytecode,
        },
    } = opts
    const p = new Program(host, code)
    p.flags = opts.flags ?? {}
    p.isLibrary = p.flags.library || false
    return p.emit()
}

export function testCompiler(host: Host, code: string) {
    const lines = code.split(/\r?\n/).map(s => {
        const m = /\/\/\s*!\s*(.*)/.exec(s)
        if (m) return m[1]
        else return null
    })
    const numerr = lines.filter(s => !!s).length
    let numExtra = 0
    const p = new Program(
        {
            write: () => {},
            log: () => {},
            getSpecs: host.getSpecs,
            verifyBytecode: host.verifyBytecode,
            mainFileName: host.mainFileName,
            error: err => {
                let isOK = false
                if (err.file) {
                    const { line } = ts.getLineAndCharacterOfPosition(
                        err.file,
                        err.start
                    )
                    const exp = lines[line]
                    const text = ts.flattenDiagnosticMessageText(
                        err.messageText,
                        "\n"
                    )
                    if (exp != null && text.indexOf(exp) >= 0) {
                        lines[line] = "" // allow more errors on the same line
                        isOK = true
                    }
                }

                if (!isOK) {
                    numExtra++
                    console.error(formatDiagnostics([err]))
                }
            },
        },
        code
    )
    const r = p.emit()
    let missingErrs = 0
    for (let i = 0; i < lines.length; ++i) {
        if (lines[i]) {
            const msg = "missing error: " + lines[i]
            const fn = host.mainFileName?.() || ""
            console.error(`${fn}(${i + 1},${1}): ${msg}`)
            missingErrs++
        }
    }
    if (missingErrs) throw new Error("some errors were not reported")
    if (numExtra) throw new Error("extra errors reported")
    if (numerr && r.success) throw new Error("unexpected success")

    if (r.success) {
        const cont = p.getAssembly()
        if (cont.indexOf("???oops") >= 0) {
            console.error(cont)
            throw new Error("bad disassembly")
        }
    }
}
