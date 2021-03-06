import * as R from 'ramda';
import React from 'react';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';

import { drillDown } from '../actions';
import {
  getRenerableBreadcrumbChunks,
  getBreadcrumbActiveIndex,
} from '../../editor/selectors';

const Breadcrumbs = ({ chunks, activeIndex, actions, children }) => (
  <div className="Breadcrumbs Breadcrumbs--debugger">
    <ul>
      {chunks.map((chunk, i) => {
        const cls = classNames('Breadcrumbs-chunk-button', {
          'is-active': i === activeIndex,
          'is-tail': i > activeIndex,
        });
        return (
          <li key={chunk.nodeId}>
            <button
              className={cls}
              onClick={() => actions.drillDown(chunk.patchPath, chunk.nodeId)}
            >
              {chunk.label}
            </button>
          </li>
        );
      })}
    </ul>
    {children}
  </div>
);

Breadcrumbs.propTypes = {
  chunks: PropTypes.arrayOf(PropTypes.object),
  activeIndex: PropTypes.number,
  actions: PropTypes.objectOf(PropTypes.func),
  children: PropTypes.node,
};

const mapStateToProps = R.applySpec({
  chunks: getRenerableBreadcrumbChunks,
  activeIndex: getBreadcrumbActiveIndex,
});

const mapDispatchToProps = dispatch => ({
  actions: bindActionCreators(
    {
      drillDown,
    },
    dispatch
  ),
});

export default connect(mapStateToProps, mapDispatchToProps)(Breadcrumbs);
