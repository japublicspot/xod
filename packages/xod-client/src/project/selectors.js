import * as R from 'ramda';
import { createSelector } from 'reselect';

import * as XP from 'xod-project';
import { foldMaybe, maybeProp } from 'xod-func-tools';
import { createPatchSearcher } from 'xod-patch-search';

import {
  addNodePositioning,
  addLinksPositioning,
  addPoints,
  slotPositionToPixels,
  slotSizeToPixels,
} from './nodeLayout';
import { SELECTION_ENTITY_TYPE } from '../editor/constants';
import {
  getSelection,
  getCurrentPatchPath,
  getLinkingPin,
} from '../editor/selectors';
import {
  getDeducedTypes,
  getErrors,
  getLinkErrors,
  getNodeErrors,
  getPinErrors,
  getPatchSearchData,
} from '../hinting/selectors';
import {
  getRenderablePinType,
  getNormalizedLabelsForPatch,
} from '../project/utils';
import { setPxPosition, setPxSize } from './pxDimensions';

import {
  getInteractiveErroredNodePinsForCurrentChunk,
  getPinsAffectedByErrorRaisersForCurrentChunk,
} from '../debugger/selectors';

import { createMemoizedSelector } from '../utils/selectorTools';

export const getProject = R.prop('project');
export const projectLens = R.lensProp('project');

//
// Patch
//

// :: (Patch -> a) -> Project -> Maybe PatchPath -> a
const getIndexedPatchEntitiesBy = R.curry((getter, project, maybePatchPath) =>
  R.compose(
    foldMaybe({}, R.compose(R.indexBy(R.prop('id')), getter)),
    R.chain(XP.getPatchByPath(R.__, project))
  )(maybePatchPath)
);

// :: State -> StrMap Comment
export const getCurrentPatchComments = createSelector(
  [getProject, getCurrentPatchPath],
  R.compose(
    R.map(
      R.compose(
        R.over(R.lens(XP.getCommentSize, setPxSize), slotSizeToPixels),
        R.over(
          R.lens(XP.getCommentPosition, setPxPosition),
          slotPositionToPixels
        )
      )
    ),
    getIndexedPatchEntitiesBy(XP.listComments)
  )
);

// :: State -> StrMap Link
export const getCurrentPatchLinks = createSelector(
  [getProject, getCurrentPatchPath],
  getIndexedPatchEntitiesBy(XP.listLinks)
);

// :: State -> StrMap Node
export const getCurrentPatchNodes = createSelector(
  [getProject, getCurrentPatchPath],
  getIndexedPatchEntitiesBy(XP.listNodes)
);

// :: State -> Maybe Patch
export const getCurrentPatch = createSelector(
  [getCurrentPatchPath, getProject],
  (patchPath, project) => R.chain(XP.getPatchByPath(R.__, project), patchPath)
);

export const getDeducedPinTypes = createMemoizedSelector(
  [getCurrentPatchPath, getDeducedTypes],
  [R.identical, R.equals],
  (maybeCurrentPatchPath, deducedPinTypes) =>
    R.compose(
      foldMaybe({}, R.identity),
      R.chain(maybeProp(R.__, deducedPinTypes))
    )(maybeCurrentPatchPath)
);

// :: { LinkId: Link } -> { NodeId: { PinKey: Boolean } }
export const computeConnectedPins = R.compose(
  R.reduce(
    (acc, link) =>
      R.compose(
        R.assocPath(
          [XP.getLinkInputNodeId(link), XP.getLinkInputPinKey(link)],
          true
        ),
        R.assocPath(
          [XP.getLinkOutputNodeId(link), XP.getLinkOutputPinKey(link)],
          true
        )
      )(acc),
    {}
  ),
  R.values
);

// returns object with a shape { nodeId: { pinKey: Boolean } }
export const getConnectedPins = createMemoizedSelector(
  [getCurrentPatchLinks],
  [R.equals],
  computeConnectedPins
);

// :: IndexedLinks -> IntermediateNode -> IntermediateNode
const assocPinIsConnected = R.curry((connectedPins, node) =>
  R.over(
    R.lensProp('pins'),
    R.map(pin =>
      R.assoc('isConnected', !!R.path([node.id, pin.key], connectedPins), pin)
    ),
    node
  )
);

// :: IntermediateNode -> IntermediateNode
const assocNodeIdToPins = node =>
  R.over(R.lensProp('pins'), R.map(R.assoc('nodeId', node.id)), node);

const addLastVariadicGroupFlag = R.curry((project, node, pins) => {
  const nodeType = XP.getNodeType(node);
  const arityStep = R.compose(
    foldMaybe(0, R.identity),
    R.chain(XP.getArityStepFromPatch),
    XP.getPatchByPath
  )(nodeType, project);

  return R.converge(R.merge, [
    R.map(R.assoc('isLastVariadicGroup', false)),
    R.compose(
      R.indexBy(XP.getPinKey),
      R.map(R.assoc('isLastVariadicGroup', true)),
      R.takeLast(arityStep),
      R.sortBy(XP.getPinOrder),
      R.filter(XP.isInputPin),
      R.values
    ),
  ])(pins);
});

// :: Project -> Patch -> IntermediateNode -> IntermediateNode
const mergePinDataFromPatch = R.curry((project, curPatch, node) =>
  R.compose(
    R.assoc('pins', R.__, node),
    addLastVariadicGroupFlag(project, node),
    XP.getPinsForNode
  )(node, curPatch, project)
);

const errorsLens = R.lens(R.propOr([], 'errors'), R.assoc('errors'));

// :: Error -> RenderableNode|RenderableLink -> RenderableNode|RenderableLink
const addError = R.curry((error, renderableEntity) =>
  R.over(errorsLens, R.append(error), renderableEntity)
);

// :: PatchErrors -> RenderableNode -> RenderableNode
const addNodeErrors = R.curry((patchPath, errors, renderableNode) =>
  R.compose(
    R.reduce(R.flip(addError), renderableNode),
    getNodeErrors(patchPath, renderableNode.id, renderableNode.type)
  )(errors)
);

/**
 * Adds `isVariadic` flag and `arityStep` prop.
 */
// :: Project -> RenderableNode -> RenderableNode
const addVariadicProps = R.curry((project, renderableNode) =>
  R.compose(
    R.merge(renderableNode),
    R.applySpec({
      isVariadic: foldMaybe(false, R.T),
      arityStep: foldMaybe(0, R.identity),
    }),
    R.chain(XP.getArityStepFromPatch),
    XP.getPatchByPath(R.__, project),
    R.prop('type')
  )(renderableNode)
);

// :: Project -> RenderableNode -> RenderableNode
const markDeprecatedNodes = R.curry((project, node) =>
  R.compose(
    R.assoc('isDeprecated', R.__, node),
    foldMaybe(false, R.identity),
    R.map(XP.isDeprecatedPatch),
    XP.getPatchByNode
  )(node, project)
);

// :: PatchPath -> Project -> [PatchPath]
const listSpecializationPatchPaths = R.curry((nodeTypeWithoutTypes, project) =>
  R.compose(
    R.filter(
      R.compose(R.equals(nodeTypeWithoutTypes), XP.getBaseNameWithoutTypes)
    ),
    XP.listPatchPaths
  )(project)
);

// :: Project -> RenderableNode -> RenderableNode
const addSpecializationsList = R.curry((project, node) => {
  const nodeTypeWithoutTypes = R.compose(
    XP.getBaseNameWithoutTypes,
    XP.getNodeType
  )(node);

  return R.compose(
    R.assoc('specializations', R.__, node),
    R.ifElse(
      R.either(
        R.compose(
          foldMaybe(false, R.identity),
          R.map(XP.isAbstractPatch),
          XP.getPatchByNode(R.__, project)
        ),
        XP.isSpecializationNode
      ),
      () => listSpecializationPatchPaths(nodeTypeWithoutTypes, project),
      R.always([])
    )
  )(node);
});

const assocDeducedPinTypes = R.curry((deducedPinTypes, node) =>
  R.over(
    R.lensProp('pins'),
    R.map(pin =>
      R.assoc(
        'deducedType',
        R.path([XP.getNodeId(node), XP.getPinKey(pin)], deducedPinTypes),
        pin
      )
    ),
    node
  )
);

const addPinErrors = R.curry((patchPath, errors, renderableNode) =>
  R.over(
    R.lensProp('pins'),
    R.map(pin =>
      R.compose(
        R.assoc('isInvalid', R.__, pin),
        R.ifElse(R.isEmpty, R.F, R.T),
        getPinErrors(patchPath, renderableNode.id, XP.getPinKey(pin))
      )(errors)
    ),
    renderableNode
  )
);

// :: Map NodeId ErrorCode -> RenderableNode -> RenderableNode
const markNodeRaisedError = R.curry((interactiveErroredNodePins, node) => {
  const hasRaisedError = R.has(node.id, interactiveErroredNodePins);
  return R.assoc('errorRaised', hasRaisedError, node);
});

// InteractiveErroredNodePins :: Map NodeId [PinKey]
// PinsAffectedByErrorRaisers :: Map NodeId (Map Pinkey [Pair PinKey NodeId])
// :: InteractiveErroredNodePins -> PinsAffectedByErrorRaisers -> [[PinKey, NodeId]]
const pickAffectedPinPairs = R.curry(
  (interactiveErroredNodePins, pinsAffectedByErrorRaisers) =>
    R.compose(
      R.unnest,
      R.unnest,
      R.map(R.values),
      R.values,
      R.mapObjIndexed((errors, nodeId) =>
        R.pick(interactiveErroredNodePins[nodeId], errors)
      ),
      R.pick(R.keys(interactiveErroredNodePins))
    )(pinsAffectedByErrorRaisers)
);

// :: InteractiveErroredNodePins -> PinsAffectedByErrorRaisers -> NodeId -> Boolean
const isNodeIdAffectedByErrorRaiser = R.curry(
  (interactiveErroredNodePins, pinsAffectedByErrorRaisers, nodeId) => {
    // :: [[PinKey, NodeId]]
    const erroredPairs = pickAffectedPinPairs(
      interactiveErroredNodePins,
      pinsAffectedByErrorRaisers
    );

    return R.any(R.propEq(1, nodeId), erroredPairs);
  }
);

// :: Patch -> InteractiveErroredNodePins -> PinsAffectedByErrorRaisers -> RenderableNode -> RenderableNode
const markNodeAffectedByErrorRaiser = R.curry(
  (
    currentPatch,
    interactiveErroredNodePins,
    pinsAffectedByErrorRaisers,
    node
  ) =>
    R.compose(
      R.assoc('isAffectedByErrorRaiser', R.__, node),
      isNodeIdAffectedByErrorRaiser
    )(interactiveErroredNodePins, pinsAffectedByErrorRaisers, node.id)
);

// :: Project -> Map NodeId ErrorCode -> Map NodeId [NodeId] -> Patch -> RenderableNode -> RenderableNode
const markPinsAffectedByErrorRaisers = R.curry(
  (
    project,
    interactiveErroredNodePins,
    pinsAffectedByErrorRaisers,
    curPatch,
    node
  ) => {
    const maybeNodesPatch = XP.getPatchByPath(node.type, project);
    // :: [[PinKey, NodeId]]
    const erroredPairs = pickAffectedPinPairs(
      interactiveErroredNodePins,
      pinsAffectedByErrorRaisers
    );

    return foldMaybe(
      node,
      nodesPatch =>
        R.over(
          R.lensProp('pins'),
          R.map(pin =>
            R.compose(
              R.when(
                () =>
                  R.compose(
                    R.gt(R.__, 0),
                    R.length,
                    R.pathOr([], [node.id, pin.key])
                  )(interactiveErroredNodePins) &&
                  XP.isPatchNotImplementedInXod(nodesPatch),
                R.assoc('isAffectedByErrorRaiser', true)
              ),
              R.when(
                () =>
                  R.any(
                    R.both(R.propEq(0, pin.key), R.propEq(1, node.id)),
                    erroredPairs
                  ),
                R.assoc('isAffectedByErrorRaiser', true)
              )
            )(pin)
          ),
          node
        ),
      maybeNodesPatch
    );
  }
);

// getRenderableNode ::
//    Node ->
//    Patch ->
//    { nodeId: { pinKey: Boolean } } ->
//    Map PatchPath DeducedPinTypes ->
//    Project ->
//    Map PatchPath PatchErrors ->
//    Map NodeId ErrorCode ->
//    Map NodeId [NodeId] ->
//    RenderableNode
export const getRenderableNode = R.curry(
  (
    node,
    currentPatch,
    connectedPins,
    deducedPinTypes,
    project,
    errors,
    interactiveErroredNodePins,
    pinsAffectedByErrorRaisers
  ) => {
    const curPatchPath = XP.getPatchPath(currentPatch);
    return R.compose(
      R.unless(
        () => R.isEmpty(interactiveErroredNodePins),
        R.compose(
          markPinsAffectedByErrorRaisers(
            project,
            interactiveErroredNodePins,
            pinsAffectedByErrorRaisers,
            currentPatch
          ),
          markNodeAffectedByErrorRaiser(
            currentPatch,
            interactiveErroredNodePins,
            pinsAffectedByErrorRaisers
          ),
          markNodeRaisedError(interactiveErroredNodePins)
        )
      ),
      assocDeducedPinTypes(deducedPinTypes),
      addSpecializationsList(project),
      markDeprecatedNodes(project),
      addPinErrors(curPatchPath, errors),
      addVariadicProps(project),
      addNodeErrors(curPatchPath, errors),
      addNodePositioning,
      assocPinIsConnected(connectedPins),
      assocNodeIdToPins,
      mergePinDataFromPatch(project, currentPatch)
    )(node);
  }
);

// :: State -> StrMap RenderableNode
export const getRenderableNodes = createMemoizedSelector(
  [
    getProject,
    getCurrentPatch,
    getCurrentPatchNodes,
    getConnectedPins,
    getDeducedPinTypes,
    getErrors,
    getInteractiveErroredNodePinsForCurrentChunk,
    getPinsAffectedByErrorRaisersForCurrentChunk,
  ],
  [
    R.equals,
    R.equals,
    R.equals,
    R.equals,
    R.equals,
    R.equals,
    R.equals,
    R.equals,
  ],
  (
    project,
    maybeCurrentPatch,
    currentPatchNodes,
    connectedPins,
    deducedPinTypes,
    errors,
    interactiveErroredNodePins,
    pinsAffectedByErrorRaisers
  ) =>
    foldMaybe(
      {},
      currentPatch =>
        R.compose(
          // If there is at least one terminal node on the patch
          // normalize empty pin labels (which equals to empty label of
          // terminal nodes) and add it into renderableNode.
          R.when(
            R.compose(
              R.any(R.pipe(R.prop('type'), XP.isTerminalPatchPath)),
              R.values
            ),
            renderableNodes =>
              R.compose(
                R.mergeWith(R.merge, renderableNodes),
                R.map(R.objOf('normalizedLabel')),
                getNormalizedLabelsForPatch
              )(currentPatch)
          ),
          // Get renderable nodes
          R.map(
            getRenderableNode(
              R.__,
              currentPatch,
              connectedPins,
              deducedPinTypes,
              project,
              errors,
              interactiveErroredNodePins,
              pinsAffectedByErrorRaisers
            )
          )
        )(currentPatchNodes),
      maybeCurrentPatch
    )
);

// :: State -> StrMap RenderableLink
export const getRenderableLinks = createMemoizedSelector(
  [
    getRenderableNodes,
    getCurrentPatchLinks,
    getCurrentPatch,
    getProject,
    getDeducedPinTypes,
    getErrors,
  ],
  [R.equals, R.equals, R.equals, R.equals, R.equals, R.equals],
  (nodes, links, curPatch, project, deducedPinTypes, errors) =>
    R.compose(
      addLinksPositioning(nodes),
      foldMaybe({}, patchPath =>
        R.map(link =>
          R.compose(
            newLink => {
              const inputNodeId = XP.getLinkInputNodeId(link);
              const inputPinKey = XP.getLinkInputPinKey(link);
              const outputNodeId = XP.getLinkOutputNodeId(link);
              const outputPinKey = XP.getLinkOutputPinKey(link);

              const isOutputPinWithError =
                nodes[outputNodeId].pins[outputPinKey]
                  .isAffectedByErrorRaiser || !!nodes[outputNodeId].errorRaised;
              const isInputPinWithError =
                nodes[inputNodeId].pins[inputPinKey].isAffectedByErrorRaiser;
              const isLinkAffectedByError =
                isOutputPinWithError && isInputPinWithError;

              return R.compose(
                R.assoc('isAffectedByErrorRaiser', isLinkAffectedByError),
                R.assoc(
                  'type',
                  getRenderablePinType(nodes[outputNodeId].pins[outputPinKey])
                )
              )(newLink);
            },
            R.ifElse(
              R.isEmpty,
              R.always(link),
              R.compose(R.assoc('dead', true), R.reduce(R.flip(addError), link))
            ),
            getLinkErrors(patchPath, XP.getLinkId(link))
          )(errors)
        )(links)
      ),
      R.map(XP.getPatchPath)
    )(curPatch)
);

// :: State -> StrMap RenderableComment
export const getRenderableComments = getCurrentPatchComments;

// :: State -> LinkGhost
export const getLinkGhost = createSelector(
  [getRenderableNodes, getLinkingPin],
  (nodes, fromPin) => {
    if (!fromPin) {
      return null;
    }

    const node = nodes[fromPin.nodeId];
    const pin = node.pins[fromPin.pinKey];

    return {
      id: '',
      type: pin.type,
      from: addPoints(pin.position, node.pxPosition),
      to: { x: 0, y: 0 },
    };
  }
);

//
// Inspector
//

// :: State -> [ RenderableSelection ]
export const getRenderableSelection = createMemoizedSelector(
  [getRenderableNodes, getRenderableLinks, getRenderableComments, getSelection],
  [R.equals, R.equals, R.equals, R.equals],
  (renderableNodes, renderableLinks, renderableComments, selection) => {
    const renderables = {
      [SELECTION_ENTITY_TYPE.NODE]: undefined, //renderableNodes,
      [SELECTION_ENTITY_TYPE.LINK]: renderableLinks,
      [SELECTION_ENTITY_TYPE.COMMENT]: renderableComments,
    };

    return R.compose(
      R.reject(R.isNil),
      R.map(
        ({ entity, id }) =>
          renderables[entity][id]
            ? {
                entityType: entity,
                data: renderables[entity][id],
              }
            : null
      )
    )(selection);
  }
);

//
// Suggester
//

// :: [PatchSearchData] -> String -> [SearchResult]
const getPatchSearcher = R.memoizeWith(R.always('fuze'), createPatchSearcher);

// :: State -> (String -> [SearchResult])
export const getSearchPatchesFn = createMemoizedSelector(
  [getPatchSearcher, getPatchSearchData, getCurrentPatchPath],
  [R.equals, R.equals, R.equals],
  (searchFn, indexData, maybeCurPatchPath) =>
    R.compose(
      searchFn,
      curPatch => R.reject(R.propEq('path', curPatch), indexData),
      foldMaybe('__NO_OPENED_PATCH__', R.identity)
    )(maybeCurPatchPath)
);
